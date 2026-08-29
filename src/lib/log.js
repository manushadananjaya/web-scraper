/**
 * The platform scrapers were written against Azure Functions' `context` object
 * (context.log / context.error). Now that we run as a plain Node server, this
 * is the shim they get instead — same shape, backed by console.
 */
const logger = {
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
};

module.exports = { logger };
