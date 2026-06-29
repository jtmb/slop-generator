/**
 * API Middleware — JWT authentication.
 *
 * Requires Authorization: Bearer <token> header on all protected routes.
 * Uses HS256 with the configured JWT_SECRET.
 */

import jwt from 'jsonwebtoken';

/**
 * Create and return a JWT authentication middleware function.
 *
 * @param {string} jwtSecret — The HS256 signing secret
 * @returns {Function} Express middleware (req, res, next)
 */
function createAuthMiddleware(jwtSecret) {
  return function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' },
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authorization must be: Bearer <token>' },
      });
    }

    try {
      const decoded = jwt.verify(parts[1], jwtSecret);
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({
        error: { code: 'TOKEN_EXPIRED', message: 'Token is invalid or expired' },
      });
    }
  };
}

export { createAuthMiddleware };
