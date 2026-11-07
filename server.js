const express = require('express');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v2: cloudinary } = require('cloudinary');
const streamifier = require('streamifier');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// ---- Cloudinary config ----
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---- PostgreSQL (Neon / Render etc.) ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Log book types ----
const logTypes = [
  'Canister Log Book',
  'Temperature Log Book',
  'Petty Cash Expense Book',
  'Inventory Book',
  'Generator Log Book'
];

// ---- Init DB & seed ----
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS log_types (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads (
        id SERIAL PRIMARY KEY,
        log_type_id INTEGER REFERENCES log_types(id),
        upload_date DATE NOT NULL,
        user_id INTEGER REFERENCES users(id),
        image_url TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(log_type_id, upload_date, user_id)
      );
    `);

    for (const name of logTypes) {
      await client.query('INSERT INTO log_types (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    }

    const adminHash = await bcrypt.hash('admin123', 10);
    const memberHash = await bcrypt.hash('member123', 10);
    await client.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
      ['admin', adminHash, 'admin']
    );
    await client.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
      ['member', memberHash, 'member']
    );

    console.log('Database initialized & seeded');
  } catch (err) {
    console.error('DB init error:', err);
  } finally {
    client.release();
  }
}

initDb();

// ---- Middleware ----
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ---- Auth ----
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } finally {
    client.release();
  }
});

// ---- Member routes ----
app.get('/api/log-types', authenticate, async (req, res) => {
  const result = await pool.query('SELECT * FROM log_types ORDER BY name');
  res.json(result.rows);
});

app.get('/api/my-uploads', authenticate, async (req, res) => {
  const result = await pool.query(`
    SELECT u.id, u.upload_date, u.image_url, u.created_at, lt.name AS log_type
    FROM uploads u
    JOIN log_types lt ON u.log_type_id = lt.id
    WHERE u.user_id = $1
    ORDER BY u.upload_date DESC, lt.name
  `, [req.user.id]);
  res.json(result.rows);
});

// Memory storage so we can pipe buffer to Cloudinary
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/upload', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { log_type_id, upload_date } = req.body || {};
    if (!log_type_id || !upload_date || !req.file) {
      return res.status(400).json({ error: 'log_type_id, upload_date and image are required' });
    }

    // Upload buffer to Cloudinary
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'logbook-evidence', resource_type: 'image' },
      async (error, result) => {
        if (error) {
          console.error('Cloudinary error:', error);
          return res.status(500).json({ error: 'Image upload to cloud failed' });
        }
        const imageUrl = result.secure_url;

        const client = await pool.connect();
        try {
          const result = await pool.query(
            `INSERT INTO uploads (log_type_id, upload_date, user_id, image_url)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (log_type_id, upload_date, user_id)
             DO UPDATE SET image_url = $4, created_at = NOW()
             RETURNING id`,
            [log_type_id, upload_date, req.user.id, imageUrl]
          );
          res.json({ message: 'Evidence uploaded', id: result.rows[0].id });
        } finally {
          client.release();
        }
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ---- Admin routes ----
app.get('/api/admin/uploads', authenticate, requireAdmin, async (req, res) => {
  const { date } = req.query;
  let result;
  if (date) {
    result = await pool.query(`
      SELECT u.id, u.upload_date, u.image_url, u.created_at, lt.name AS log_type, us.username
      FROM uploads u
      JOIN log_types lt ON u.log_type_id = lt.id
      JOIN users us ON u.user_id = us.id
      WHERE u.upload_date = $1
      ORDER BY lt.name, us.username
    `, [date]);
  } else {
    result = await pool.query(`
      SELECT u.id, u.upload_date, u.image_url, u.created_at, lt.name AS log_type, us.username
      FROM uploads u
      JOIN log_types lt ON u.log_type_id = lt.id
      JOIN users us ON u.user_id = us.id
      ORDER BY u.upload_date DESC, lt.name
      LIMIT 200
    `);
  }
  res.json(result.rows);
});

app.get('/api/admin/checklist/:date', authenticate, requireAdmin, async (req, res) => {
  const { date } = req.params;
  const typesResult = await pool.query('SELECT * FROM log_types ORDER BY name');
  const membersResult = await pool.query("SELECT id, username FROM users WHERE role = 'member' ORDER BY username");

  const checklist = [];
  for (const type of typesResult.rows) {
    const uploadsResult = await pool.query(
      `SELECT u.id, u.image_url, u.created_at, us.username
       FROM uploads u
       JOIN users us ON u.user_id = us.id
       WHERE u.log_type_id = $1 AND u.upload_date = $2`,
      [type.id, date]
    );
    checklist.push({
      log_type_id: type.id,
      log_type: type.name,
      filled: uploadsResult.rows.length > 0,
      uploads: uploadsResult.rows
    });
  }

  res.json({ date, members: membersResult.rows, checklist });
});

app.delete('/api/admin/upload/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM uploads WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cloud checklist server running on port ${PORT}`);
});
