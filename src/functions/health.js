const { app } = require('@azure/functions');
const { isAzure, resolveExecutablePath } = require('../lib/browser');

app.http('health', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'health',
    handler: async (request, context) => {
        const checks = { runtime: isAzure ? 'azure' : 'local' };

        try {
            checks.chromiumExecutablePath = await resolveExecutablePath();
            return {
                status: 200,
                jsonBody: { success: true, ...checks },
            };
        } catch (err) {
            context.error('Health check failed to resolve chromium:', err.message);
            return {
                status: 503,
                jsonBody: { success: false, ...checks, error: err.message },
            };
        }
    },
});
