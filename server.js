const express = require('express')
const cors = require('cors')
const Database = require('better-sqlite3')
const fetch = require('node-fetch')
const fs = require('fs')
const path = require('path')
const app = express()

app.use(cors())
app.use(express.json())

// Serve all downloaded img on page
app.use('/images', express.static(path.join(__dirname, 'images')))

// Make images folder if it doesn't exist
if (!fs.existsSync('./images')) fs.mkdirSync('./images')

const MAX_AGE_DAYS = 7

function cleanupImages() {
  const folder = path.join(__dirname, 'images')
  const files = fs.readdirSync(folder)
  const now = Date.now()
  let deleted = 0

  files.forEach(file => {
    const filepath = path.join(folder, file)
    const stat = fs.statSync(filepath)
    const ageInDays = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24)
    if (ageInDays > MAX_AGE_DAYS) {
      fs.unlinkSync(filepath)
      deleted++
    }
  })

  if (deleted > 0) console.log(`Cleaned up ${deleted} old image(s)`)
}

// Run cleanup on startup and every 24 hours
cleanupImages()
setInterval(cleanupImages, 1000 * 60 * 60 * 24)

const db = new Database('hub.db')

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    content TEXT,
    embeds TEXT,
    attachments TEXT,
    timestamp TEXT,
    receivedAt TEXT
  )
`)

// Downloads the Discord image and saves it locally
async function saveImage(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const ext = '.png'
    const filename = `${Date.now()}${ext}`
    const filepath = path.join(__dirname, 'images', filename)
    const buffer = await res.buffer()
    fs.writeFileSync(filepath, buffer)
    return `/images/${filename}` // return local path
  } catch (err) {
    console.error('Failed to save image:', err)
    return null
  }
}

app.post('/api/logs', async (req, res) => {
  const { user, content, embeds, attachments, timestamp } = req.body

  // Download any images in embeds and replace URLs with local paths
  const processedEmbeds = await Promise.all(embeds.map(async embed => {
    if (embed.image) {
      const localUrl = await saveImage(embed.image)
      return { ...embed, image: localUrl || embed.image }
    }
    return embed
  }))

  db.prepare(`
    INSERT INTO logs (user, content, embeds, attachments, timestamp, receivedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
      user,
      content,
      JSON.stringify(processedEmbeds),
      JSON.stringify(attachments),
      timestamp,
      new Date().toISOString()
  )

  console.log('Received log:', embeds?.[0]?.description)
  res.json({ ok: true })
})

app.get('/api/logs', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM logs ORDER BY id DESC LIMIT 100
  `).all()
  res.json(rows.map(row => ({
    ...row,
    embeds: JSON.parse(row.embeds),
    attachments: JSON.parse(row.attachments)
  })))
})

app.get('/api/screenshot', (req, res) => {
  const rows = db.prepare(`
    SELECT embeds FROM logs ORDER BY id DESC LIMIT 100
  `).all()
  const latest = rows.find(row => {
    const embeds = JSON.parse(row.embeds)
    return embeds?.[0]?.image
  })
  const url = latest ? JSON.parse(latest.embeds)?.[0]?.image : null
  res.json({ url })
})

// basic health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

const PORT = 3001

// Tasks table setup
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
)`)

// GET all tasks
app.get('/api/tasks', (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC').all()
  res.json(tasks)
})

// POST a new task
app.post('/api/tasks', (req, res) => {
  const { title, description } = req.body
  if (!title) return res.status(400).json({ error: 'Title is required' })
  const stmt = db.prepare('INSERT INTO tasks (title, description) VALUES (?, ?)')
  const result = stmt.run(title, description || '')
  res.json({ id: result.lastInsertRowid, title, description })
})

// DELETE a task
app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})
app.listen(PORT, () => console.log(`API server running on port ${PORT}`))