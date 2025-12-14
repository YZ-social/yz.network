/**
 * Simple logging utility with levels
 * Reduces console spam while keeping essential debugging info
 */

export class Logger {
  static levels = {
    ERROR: 0,
    WARN: 1, 
    INFO: 2,
    DEBUG: 3,
    TRACE: 4
  };

  // Set default log level (can be overridden via URL param or localStorage)
  static currentLevel = Logger.levels.INFO;

  static init() {
    // Check URL params for log level
    const urlParams = new URLSearchParams(window.location.search);
    const logLevel = urlParams.get('logLevel');
    if (logLevel && Logger.levels[logLevel.toUpperCase()] !== undefined) {
      Logger.currentLevel = Logger.levels[logLevel.toUpperCase()];
      console.log(`🔧 Log level set to ${logLevel.toUpperCase()} via URL param`);
    }

    // Check localStorage for persistent log level
    const storedLevel = localStorage.getItem('dht_log_level');
    if (storedLevel && Logger.levels[storedLevel.toUpperCase()] !== undefined) {
      Logger.currentLevel = Logger.levels[storedLevel.toUpperCase()];
      console.log(`🔧 Log level set to ${storedLevel.toUpperCase()} from localStorage`);
    }

    // Expose global functions for easy log level changes
    window.setLogLevel = (level) => {
      if (Logger.levels[level.toUpperCase()] !== undefined) {
        Logger.currentLevel = Logger.levels[level.toUpperCase()];
        localStorage.setItem('dht_log_level', level.toUpperCase());
        console.log(`🔧 Log level changed to ${level.toUpperCase()}`);
      } else {
        console.error(`Invalid log level: ${level}. Use: ERROR, WARN, INFO, DEBUG, TRACE`);
      }
    };

    window.getLogLevel = () => {
      const levelName = Object.keys(Logger.levels).find(key => Logger.levels[key] === Logger.currentLevel);
      console.log(`Current log level: ${levelName}`);
      return levelName;
    };
  }

  static shouldLog(level) {
    return Logger.levels[level] <= Logger.currentLevel;
  }

  static error(component, message, ...args) {
    if (Logger.shouldLog('ERROR')) {
      console.error(`❌ [${component}] ${message}`, ...args);
    }
  }

  static warn(component, message, ...args) {
    if (Logger.shouldLog('WARN')) {
      console.warn(`⚠️ [${component}] ${message}`, ...args);
    }
  }

  static info(component, message, ...args) {
    if (Logger.shouldLog('INFO')) {
      console.log(`ℹ️ [${component}] ${message}`, ...args);
    }
  }

  static debug(component, message, ...args) {
    if (Logger.shouldLog('DEBUG')) {
      console.log(`🔧 [${component}] ${message}`, ...args);
    }
  }

  static trace(component, message, ...args) {
    if (Logger.shouldLog('TRACE')) {
      console.log(`🔍 [${component}] ${message}`, ...args);
    }
  }

  // Special methods for common patterns
  static connection(component, message, ...args) {
    if (Logger.shouldLog('INFO')) {
      console.log(`🔗 [${component}] ${message}`, ...args);
    }
  }

  static dht(component, message, ...args) {
    if (Logger.shouldLog('DEBUG')) {
      console.log(`📡 [${component}] ${message}`, ...args);
    }
  }

  static ping(component, message, ...args) {
    if (Logger.shouldLog('TRACE')) {
      console.log(`🏓 [${component}] ${message}`, ...args);
    }
  }

  static metrics(component, message, ...args) {
    if (Logger.shouldLog('TRACE')) {
      console.log(`📊 [${component}] ${message}`, ...args);
    }
  }
}

// Initialize on import
if (typeof window !== 'undefined') {
  Logger.init();
}