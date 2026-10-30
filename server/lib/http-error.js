// The one status-carrying refusal; anything thrown without a status is a logged 500.

/**
 * An Error the app's error handler answers with statusCode and message; fields ride along.
 * @param {number} statusCode
 * @param {string} message
 * @param {object} [fields]
 * @returns {Error & {statusCode: number}}
 */
export function httpError(statusCode, message, fields) {
    return Object.assign(new Error(message), fields, { statusCode });
}
