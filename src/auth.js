import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : req.cookies?.study_buddy_token;
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' });
  try {
    const claims = jwt.verify(token, req.app.locals.jwtSecret);
    const user = req.app.locals.db.prepare('SELECT id,email,role FROM users WHERE id=?').get(claims.id);
    if (!user) return res.status(401).json({ error: 'Please log in to continue.' });
    req.user = user;
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
