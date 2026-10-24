import jwt from 'jsonwebtoken';
import { HttpError, publicUser } from '../utils/domain.js';
export const cookieOptions = production => ({
  httpOnly: true,
  secure: production,
  sameSite: production ? 'none' : 'strict',
  path: '/',
  maxAge: 8 * 60 * 60 * 1000,
});
export function issueSession(res, user, config) {
  const token = jwt.sign({ sub: user._id, ver: user.sessionVersion || 0 }, config.jwtSecret, { expiresIn: '8h', issuer: 'hcm-lite', audience: 'hcm-workspace', algorithm: 'HS256' });
  res.cookie('hcm_session', token, cookieOptions(config.production));
  return publicUser(user);
}
export function authenticate(db, config) {
  return async (req, res, next) => {
    let decoded;
    try { decoded = jwt.verify(req.cookies.hcm_session || '', config.jwtSecret, { issuer: 'hcm-lite', audience: 'hcm-workspace', algorithms: ['HS256'] }); }
    catch { throw new HttpError(401, 'Please sign in to continue.'); }
    const user = await db.one('users', { _id: decoded.sub });
    if (!user?.active || (decoded.ver ?? 0) !== (user.sessionVersion || 0)) throw new HttpError(401, 'Your session is no longer active.');
    req.user = user; next();
  };
}
export const allow = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Your role does not have access to this action.'));
