import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from './models/User.js';

export async function requireAuth(req, res, next) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : req.cookies?.study_buddy_token;
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' });
  try {
    const claims = jwt.verify(token, req.app.locals.jwtSecret);
    if (!mongoose.isObjectIdOrHexString(claims.id)) return res.status(401).json({ error: 'Please log in to continue.' });
    const user = await User.findById(claims.id).select('email role').lean();
    if (!user) return res.status(401).json({ error: 'Please log in to continue.' });
    req.user = { ...user, id: user._id.toString() };
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Your session expired. Please log in again.' });
    }
    next(error);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access only.' });
  next();
}
