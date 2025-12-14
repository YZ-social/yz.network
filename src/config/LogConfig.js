/**
 * Logging configuration for DHT components
 * Reduces console spam while keeping essential info
 */

// Default log levels for different components
export const LOG_CONFIG = {
  // Connection management (most verbose)
  CONNECTION_MANAGER: 'WARN',    // Only warnings and errors
  WEBSOCKET_MANAGER: 'WARN',     // Only warnings and errors  
  WEBRTC_MANAGER: 'WARN',        // Only warnings and errors
  
  // DHT operations (moderate)
  DHT_CORE: 'INFO',              // Important operations only
  ROUTING_TABLE: 'WARN',         // Only warnings and errors
  PEER_DISCOVERY: 'INFO',        // Peer connections are important
  
  // PubSub (important for debugging)
  PUBSUB: 'INFO',                // Keep PubSub logs for debugging
  
  // Maintenance (very verbose)
  PING_PONG: 'ERROR',            // Only errors (pings are too frequent)
  METRICS: 'ERROR',              // Only errors (metrics are too frequent)
  MAINTENANCE: 'WARN',           // Only warnings and errors
  
  // Bootstrap and auth (important)
  BOOTSTRAP: 'INFO',             // Keep bootstrap logs
  AUTH: 'INFO',                  // Keep auth logs
};

// Helper to check if we should log at a given level
export function shouldLog(component, level) {
  const componentLevel = LOG_CONFIG[component] || 'INFO';
  const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
  return levels[level] <= levels[componentLevel];
}

// Helper logging functions
export function logError(component, message, ...args) {
  if (shouldLog(component, 'ERROR')) {
    console.error(`❌ [${component}] ${message}`, ...args);
  }
}

export function logWarn(component, message, ...args) {
  if (shouldLog(component, 'WARN')) {
    console.warn(`⚠️ [${component}] ${message}`, ...args);
  }
}

export function logInfo(component, message, ...args) {
  if (shouldLog(component, 'INFO')) {
    console.log(`ℹ️ [${component}] ${message}`, ...args);
  }
}

export function logDebug(component, message, ...args) {
  if (shouldLog(component, 'DEBUG')) {
    console.log(`🔧 [${component}] ${message}`, ...args);
  }
}

// Special logging for common patterns
export function logConnection(component, message, ...args) {
  if (shouldLog(component, 'INFO')) {
    console.log(`🔗 [${component}] ${message}`, ...args);
  }
}

export function logPing(component, message, ...args) {
  if (shouldLog(component, 'TRACE')) {
    console.log(`🏓 [${component}] ${message}`, ...args);
  }
}

// Global function to change log levels at runtime
if (typeof window !== 'undefined') {
  window.setComponentLogLevel = (component, level) => {
    if (LOG_CONFIG.hasOwnProperty(component) && ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].includes(level)) {
      LOG_CONFIG[component] = level;
      console.log(`🔧 Set ${component} log level to ${level}`);
    } else {
      console.error(`Invalid component (${component}) or level (${level})`);
      console.log('Available components:', Object.keys(LOG_CONFIG));
    }
  };
  
  window.showLogConfig = () => {
    console.table(LOG_CONFIG);
  };
  
  // Quick presets
  window.setQuietMode = () => {
    Object.keys(LOG_CONFIG).forEach(component => {
      LOG_CONFIG[component] = component.includes('PUBSUB') || component.includes('BOOTSTRAP') || component.includes('AUTH') ? 'INFO' : 'WARN';
    });
    console.log('🔇 Quiet mode enabled - reduced logging');
  };
  
  window.setVerboseMode = () => {
    Object.keys(LOG_CONFIG).forEach(component => {
      LOG_CONFIG[component] = 'DEBUG';
    });
    console.log('🔊 Verbose mode enabled - full logging');
  };
}