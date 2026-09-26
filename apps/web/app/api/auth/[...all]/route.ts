import { handleAuthRequest } from '@sales-tracker/core';

// Better Auth's HTTP API, behind core's allow-list (sign-in, sign-out, session). Every other
// route returns 404; user management goes through core services (can() + audit log).
export { handleAuthRequest as GET, handleAuthRequest as POST };
