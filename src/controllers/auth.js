import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { authenticate, cookieOptions, issueSession } from '../middleware/auth.js';
import { assert, publicUser, validTimezone } from '../utils/domain.js';
import { defaultLeaveTypes } from '../services/seed.js';

export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg });
  next();
};
export function authRouter(db, config) {
  const router = Router();
  const limit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many sign-in attempts. Please try again in 15 minutes.' } });
  router.get('/status', async (req, res) => res.json({
    initialized: !!await db.one('companies'),
    mode: db.mode,
    assistant: config.openAiApiKey ? 'openai' : 'local-insights',
  }));
  router.post('/setup', limit,
    body('companyName').isString().trim().isLength({ min: 2, max: 100 }).withMessage('Company name must be 2–100 characters.'),
    body('companyEmail').optional({ values: 'falsy' }).isEmail().withMessage('Enter a valid company email address.').normalizeEmail(),
    body('companyPhone').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }).withMessage('Company phone must be 40 characters or fewer.'),
    body('companyAddress').optional({ values: 'falsy' }).isString().trim().isLength({ max: 300 }).withMessage('Company address must be 300 characters or fewer.'),
    body('timezone').optional({ values: 'falsy' }).isString().trim().isLength({ min: 1, max: 100 }).custom(validTimezone).withMessage('Choose a valid IANA timezone.'),
    body('name').isString().trim().isLength({ min: 2, max: 80 }).withMessage('Enter your full name.'),
    body('email').isEmail().withMessage('Enter a valid email address.').normalizeEmail(),
    body('password').isString().isLength({ min: 8, max: 72 }).withMessage('Use a password with 8–72 characters.'), validate,
    async (req, res) => {
      assert(db.mode !== 'demo', 'Demo workspace is already set up.', 409);
      assert(!await db.one('companies'), 'This company has already been set up.', 409);
      const password = await bcrypt.hash(req.body.password, 12);
      const result = await db.transaction(async tx => {
        assert(!await tx.one('companies'), 'This company has already been set up.', 409);
        const company = await tx.insert('companies', {
          _id: 'workspace',
          name: req.body.companyName,
          email: req.body.companyEmail || '',
          phone: req.body.companyPhone || '',
          address: req.body.companyAddress || '',
          country: 'Pakistan',
          currency: 'PKR',
          timezone: req.body.timezone || 'Asia/Karachi',
        });
        const user = await tx.insert('users', { name: req.body.name, email: req.body.email, password, role: 'admin', active: true });
        for (const type of defaultLeaveTypes) await tx.insert('leaveTypes', type);
        await tx.insert('auditLogs', { userId: user._id, action: 'Company created', details: company.name });
        return { company, user };
      });
      res.status(201).json({ user: issueSession(res, result.user, config), company: result.company });
    });
  router.post('/login', limit,
    body('email').isEmail().withMessage('Enter a valid email address.').normalizeEmail(),
    body('password').isString().isLength({ min: 1, max: 72 }).withMessage('Enter your password.'), validate,
    async (req, res) => {
      const user = await db.one('users', { email: req.body.email });
      const valid = user && await bcrypt.compare(req.body.password, user.password);
      assert(valid && user.active, 'Email or password is incorrect.', 401);
      res.json({ user: issueSession(res, user, config), company: await db.one('companies') });
    });
  router.post('/demo', limit, async (req, res) => {
    assert(db.mode === 'demo' && !config.production, 'Demo access is disabled.', 404);
    const role = req.body.role || 'admin';
    assert(['admin', 'hr', 'employee'].includes(role), 'Select a valid role.');
    const user = await db.one('users', { role, active: true });
    assert(user, 'Demo account is unavailable.', 404);
    res.json({ user: issueSession(res, user, config), company: await db.one('companies') });
  });
  router.post('/logout', (req, res) => { res.clearCookie('hcm_session', { ...cookieOptions(config.production), maxAge: undefined }); res.json({ ok: true }); });
  router.get('/me', authenticate(db, config), async (req, res) => res.json({ user: publicUser(req.user), company: await db.one('companies'), mode: db.mode }));
  router.patch('/profile', authenticate(db, config),
    body('name').optional().isString().trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2–80 characters.'),
    body('email').optional().isEmail().withMessage('Enter a valid email address.').normalizeEmail(),
    validate,
    async (req, res) => {
      const changes = Object.fromEntries(['name', 'email'].filter(key => req.body[key] !== undefined).map(key => [key, req.body[key]]));
      assert(Object.keys(changes).length, 'Enter a name or email address to update.');
      if (changes.email) {
        const existing = await db.one('users', { email: changes.email });
        assert(!existing || existing._id === req.user._id, 'An account already uses this email address.', 409);
      }
      const user = await db.transaction(async tx => {
        const updated = await tx.update('users', { _id: req.user._id }, changes);
        if (req.user.employeeId) {
          await tx.update('employees', { _id: req.user.employeeId }, changes);
        }
        await tx.insert('auditLogs', { userId: req.user._id, action: 'Profile updated', details: '' });
        return updated;
      });
      res.json({ user: publicUser(user) });
    });
  router.patch('/password', limit, authenticate(db, config),
    body('currentPassword').isString().isLength({ min: 1, max: 72 }).withMessage('Enter your current password.'),
    body('newPassword').isString().isLength({ min: 8, max: 72 }).withMessage('Use a new password with 8–72 characters.'), validate,
    async (req, res) => {
      assert(await bcrypt.compare(req.body.currentPassword, req.user.password), 'Your current password is incorrect.', 400);
      assert(req.body.currentPassword !== req.body.newPassword, 'Choose a password different from your current one.');
      await db.transaction(async tx => {
        await tx.update('users', { _id: req.user._id }, {
          password: await bcrypt.hash(req.body.newPassword, 12),
          sessionVersion: (req.user.sessionVersion || 0) + 1,
        });
        await tx.insert('auditLogs', { userId: req.user._id, action: 'Password changed', details: '' });
      });
      res.clearCookie('hcm_session', { ...cookieOptions(config.production), maxAge: undefined });
      res.json({ ok: true });
    });
  return router;
}
