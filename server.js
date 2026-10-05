'use strict';
/*
  Tally server: serves the app from ./www and exposes a small JSON API backed by MongoDB.
  The MongoDB connection string stays here on the server (environment variable MONGODB_URI).
  It is never sent to the browser or the phone app.
*/
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const USER_RE = /^[a-z0-9_.-]{3,24}$/;
const KEY_RE = /^g:[A-Z0-9]{6}:(meta|m:[A-Za-z0-9]{3,40}|c:[A-Za-z0-9]{3,40})$/;
const PREFIX_RE = /^g:[A-Za-z0-9:]{0,40}$/;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const int = v => Math.max(0, Math.min(1e6, Math.round(Number(v) || 0)));

/* Only summary fields are ever stored for a group member, whatever the client sends. */
function cleanMember(v){
  if(!v || typeof v !== 'object') return null;
  const t = v.today || {};
  return {
    id: str(v.id, 40), name: str(v.name, 24), color: /^#[0-9a-fA-F]{3,8}$/.test(v.color) ? v.color : '#8B9BFF', avatar: str(v.avatar, 4),
    updated: Number(v.updated) || Date.now(), today: { done: int(t.done), total: int(t.total) },
    week: v.week == null ? null : Math.max(0, Math.min(1, Number(v.week) || 0)),
    best: int(v.best), longest: int(v.longest), checkins: int(v.checkins),
    habits: (Array.isArray(v.habits) ? v.habits : []).slice(0, 8).map(h => ({ e: str(h && h.e, 8), n: str(h && h.n, 28), s: int(h && h.s) }))
  };
}
function cleanCheers(arr){
  return (Array.isArray(arr) ? arr : []).slice(-20).map(c => ({ from: str(c && c.from, 24), e: str(c && c.e, 8), t: Number(c && c.t) || 0 })).filter(c => c.from && c.t);
}

function createApp({ db, jwtSecret, corsOrigin, staticDir }){
  const app = express();
  const users = db.collection('users'), userdata = db.collection('userdata'), shared = db.collection('shared');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));

  const allowed = String(corsOrigin || '').split(',').map(s => s.trim()).filter(Boolean);
  app.use('/api', cors({ origin: (origin, cb) => cb(null, !origin || allowed.includes('*') || allowed.includes(origin)), maxAge: 86400 }));
  app.use(express.json({ limit: '2mb' }));

  const limiter = (limit) => rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again in a few minutes.' } });
  app.use('/api', limiter(1500));
  const authLimiter = limiter(40);

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => { console.error(err && err.message); res.status(500).json({ error: 'Something went wrong on the server.' }); });
  const sign = u => jwt.sign({ uid: u._id, un: u.username }, jwtSecret, { expiresIn: '30d' });
  const auth = async (req, res, next) => {
    const h = req.headers.authorization || '';
    try {
      const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', jwtSecret);
      if(!(await users.findOne({ _id: p.uid }))) throw new Error('gone');      // deleted accounts stop working at once
      req.user = { id: p.uid, username: p.un }; next();
    } catch(e){ res.status(401).json({ error: 'Please sign in again.' }); }
  };
  const DUMMY = bcrypt.hashSync('not-a-real-password', 10);

  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'tally' }));

  /* ----- accounts ----- */
  app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
    const username = str(req.body.username, 40).trim().toLowerCase(), password = str(req.body.password, 300);
    if(!USER_RE.test(username)) return res.status(400).json({ error: 'Username needs 3 to 24 characters: letters, numbers, dot, dash or underscore.' });
    if(password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const doc = { _id: crypto.randomUUID(), username, passHash: await bcrypt.hash(password, 10), createdAt: Date.now() };
    try { await users.insertOne(doc); }
    catch(e){ if(e && e.code === 11000) return res.status(409).json({ error: 'That username is taken.' }); throw e; }
    res.status(201).json({ token: sign(doc), user: { id: doc._id, username } });
  }));
  app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
    const username = str(req.body.username, 40).trim().toLowerCase(), password = str(req.body.password, 300);
    const u = USER_RE.test(username) ? await users.findOne({ username }) : null;
    const ok = await bcrypt.compare(password, u ? u.passHash : DUMMY);
    if(!u || !ok) return res.status(401).json({ error: 'Wrong username or password.' });
    res.json({ token: sign(u), user: { id: u._id, username: u.username } });
  }));
  app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));
  app.delete('/api/auth/me', authLimiter, auth, wrap(async (req, res) => {
    const u = await users.findOne({ _id: req.user.id });
    if(!u || !(await bcrypt.compare(str(req.body && req.body.password, 300), u.passHash))) return res.status(401).json({ error: 'Wrong password.' });
    await users.deleteOne({ _id: u._id }); await userdata.deleteOne({ _id: u._id }); await shared.deleteMany({ owner: u._id });
    res.json({ ok: true });
  }));

  /* ----- one document per user: all their people, habits, logs, notes and badges ----- */
  app.get('/api/data', auth, wrap(async (req, res) => {
    const d = await userdata.findOne({ _id: req.user.id });
    res.json(d ? { data: d.data, updatedAt: d.updatedAt } : { data: null, updatedAt: 0 });
  }));
  app.put('/api/data', auth, wrap(async (req, res) => {
    const { data, baseUpdatedAt } = req.body || {};
    if(!data || !Array.isArray(data.people) || !data.people.length || data.people.length > 30) return res.status(400).json({ error: 'Invalid data.' });
    const base = Number(baseUpdatedAt) || 0, now = Date.now();
    try { await userdata.updateOne({ _id: req.user.id, updatedAt: { $lte: base } }, { $set: { data, updatedAt: now } }, { upsert: true }); }
    catch(e){
      if(e && e.code === 11000){ const cur = await userdata.findOne({ _id: req.user.id }); return res.status(409).json({ error: 'conflict', data: cur.data, updatedAt: cur.updatedAt }); }
      throw e;
    }
    res.json({ updatedAt: now });
  }));

  /* ----- friends groups: shared key/value, group code is the secret ----- */
  app.get('/api/kv', auth, wrap(async (req, res) => {
    const key = str(req.query.key, 80);
    if(!KEY_RE.test(key)) return res.status(400).json({ error: 'Bad key.' });
    const d = await shared.findOne({ _id: key });
    if(!d) return res.status(404).json({ error: 'Not found.' });
    res.json({ value: d.value });
  }));
  app.get('/api/kv/list', auth, wrap(async (req, res) => {
    const prefix = str(req.query.prefix, 80);
    if(!PREFIX_RE.test(prefix)) return res.status(400).json({ error: 'Bad prefix.' });
    const docs = await shared.find({ _id: { $regex: '^' + escapeRe(prefix) } }, { projection: { _id: 1 } }).toArray();
    res.json({ keys: docs.map(d => d._id).slice(0, 200) });
  }));
  app.put('/api/kv', auth, wrap(async (req, res) => {
    const key = str(req.body && req.body.key, 80), value = req.body && req.body.value;
    if(!KEY_RE.test(key) || value == null || JSON.stringify(value).length > 20000) return res.status(400).json({ error: 'Bad request.' });
    const [, code, kind] = key.match(/^g:([A-Z0-9]{6}):(meta|m|c)/);
    const now = Date.now();
    if(kind === 'meta'){
      if(await shared.findOne({ _id: key })) return res.json({ ok: true, existing: true });
      try { await shared.insertOne({ _id: key, value: { created: now, by: str(value.by, 24) }, owner: req.user.id, updatedAt: now }); }
      catch(e){ if(!(e && e.code === 11000)) throw e; }
      return res.json({ ok: true });
    }
    if(!(await shared.findOne({ _id: `g:${code}:meta` }))) return res.status(400).json({ error: 'No such group.' });
    const cur = await shared.findOne({ _id: key });
    if(kind === 'm'){
      if(cur && cur.owner !== req.user.id) return res.status(403).json({ error: 'That entry belongs to someone else.' });
      const clean = cleanMember(value); if(!clean) return res.status(400).json({ error: 'Bad member.' });
      await shared.updateOne({ _id: key }, { $set: { value: clean, owner: req.user.id, updatedAt: now } }, { upsert: true });
      return res.json({ ok: true });
    }
    const seen = new Set(), merged = [...cleanCheers(cur && cur.value), ...cleanCheers(value)]
      .filter(c => { const k = c.from + '|' + c.t; if(seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.t - b.t).slice(-20);
    await shared.updateOne({ _id: key }, { $set: { value: merged, updatedAt: now } }, { upsert: true });
    res.json({ ok: true });
  }));
  app.delete('/api/kv', auth, wrap(async (req, res) => {
    const key = str(req.query.key, 80);
    if(!KEY_RE.test(key) || !/:m:/.test(key)) return res.status(400).json({ error: 'Bad key.' });
    const cur = await shared.findOne({ _id: key });
    if(cur && cur.owner !== req.user.id) return res.status(403).json({ error: 'That entry belongs to someone else.' });
    if(cur) await shared.deleteOne({ _id: key });
    res.json({ ok: true });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  if(staticDir){
    app.use(express.static(staticDir, { setHeaders: (res, p) => { if(/sw\.js$|config\.js$|index\.html$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));
  }
  return app;
}

if(require.main === module){
  require('dotenv').config();
  const { MongoClient } = require('mongodb');
  const uri = process.env.MONGODB_URI, secret = process.env.JWT_SECRET;
  if(!uri || !secret){
    console.error('Missing MONGODB_URI or JWT_SECRET. Copy .env.example to .env and fill both in.');
    process.exit(1);
  }
  if(secret.length < 24) console.warn('Warning: JWT_SECRET is short. Use a long random value.');
  (async () => {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'tally');
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    const app = createApp({ db, jwtSecret: secret, corsOrigin: process.env.CORS_ORIGIN, staticDir: path.join(__dirname, 'www') });
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Tally is running on port ${port}`));
  })().catch(e => { console.error('Could not start:', e.message); process.exit(1); });
}
module.exports = { createApp };
