/**
 * Logger utility with configurable verbosity levels
 * 
 * Log levels:
 * - error: Always logged (critical errors)
 * - warn: Always logged (warnings)
 * - info: Logged unless LOG_LEVEL=error (important events)
 * - debug: Only logged when DEBUG=true or LOG_LEVEL=debug (verbose)
 * - trace: Only logged when LOG_LEVEL=trace (extremely verbose)
 * 
 * Environment variables:
 * - DEBUG=true: Enable debug logging
 * - LOG_LEVEL=error|warn|info|debug|trace: Set minimum log level
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

// Determine log level from environment
function getLogLevel() {
  const envLevel = (typeof process !== 'undefined' && process.env?.LOG_LEVEL) || 'info';
  const debugEnabled = typeof process !== 'undefined' && process.env?.DEBUG === 'true';
  
  if (debugEnabled && LOG_LEVELS[envLevel] < LOG_LEVELS.debug) {
    return LOG_LEVELS.debug;
  }
  
  return LOG_LEVELS[envLevel] ?? LOG_LEVELS.info;
}

const currentLevel = getLogLevel();

/**
 * Check if a log level should be output
 */
function shouldLog(level) {
  return LOG_LEVELS[level] <= currentLevel;
}

/**
 * Logger with level-based filtering
 */
const Logger = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
  
  info: (...args) => {
    if (shouldLog('info')) console.log(...args);
  },
  
  debug: (...args) => {
    if (shouldLog('debug')) console.log(...args);
  },
  
  trace: (...args) => {
    if (shouldLog('trace')) console.log(...args);
  },
  
  // Convenience method for ping/pong (trace level - very verbose)
  ping: (...args) => {
    if (shouldLog('trace')) console.log(...args);
  },
  
  // Convenience method for metrics (debug level)
  metrics: (...args) => {
    if (shouldLog('debug')) console.log(...args);
  },
  
  // Get current log level name
  getLevel: () => {
    for (const [name, value] of Object.entries(LOG_LEVELS)) {
      if (value === currentLevel) return name;
    }
    return 'info';
  },
  
  // Check if debug is enabled
  isDebugEnabled: () => shouldLog('debug'),
  
  // Check if trace is enabled
  isTraceEnabled: () => shouldLog('trace')
};

export default Logger;
export { Logger, shouldLog, LOG_LEVELS };
