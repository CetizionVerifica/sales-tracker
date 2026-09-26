// Runs once when the server starts: validate env so bad config fails fast.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getEnv } = await import('@sales-tracker/core/env');
    getEnv();
  }
}
