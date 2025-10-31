/**
 * Simple logging utility with configurable log levels
 *
 * Usage:
 * - Set environment variable: DEBUG_LEVEL=warn (or error, info, debug, trace)
 * - Default level: info (shows error, warn, info)
 *
 * Levels (from least to most verbose):
 * - error: Critical errors only
 * - warn: Warnings and errors
 * - info: General information, warnings, and errors (default)
 * - debug: Detailed debugging information
 * - trace: Very verbose tracing information
 */

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

// Get log level from environment or default to 'info'
const configuredLevel = (typeof process !== 'undefined' && process.env?.DEBUG_LEVEL)
  ? process.env.DEBUG_LEVEL.toLowerCase()
  : 'info';

const currentLevel = LEVELS[configuredLevel] ?? LEVELS.info;

class Logger {
  constructor(category = '') {
    this.category = category;
  }

  _log(level, ...args) {
    if (LEVELS[level] <= currentLevel) {
      const prefix = this.category ? `[${this.category}]` : '';
      console.log(prefix, ...args);
    }
  }

  error(...args) {
    this._log('error', ...args);
  }

  warn(...args) {
    this._log('warn', ...args);
  }

  info(...args) {
    this._log('info', ...args);
  }

  debug(...args) {
    this._log('debug', ...args);
  }

  trace(...args) {
    this._log('trace', ...args);
  }

  // Convenience method to check if a level is enabled
  isEnabled(level) {
    return LEVELS[level] <= currentLevel;
  }
}

// Export singleton for convenience
export const logger = new Logger();

// Export class for creating categorized loggers
export default Logger;

// Export current level for conditional logging
export const logLevel = configuredLevel;
export const isDebugEnabled = () => currentLevel >= LEVELS.debug;
export const isTraceEnabled = () => currentLevel >= LEVELS.trace;
