import { getAuth } from '@sales-tracker/core';

// Better Auth's HTTP API (sign-in, sign-out, session). Admin and sign-up routes are
// disabled in core; user management goes through core services.
const handle = (request: Request) => getAuth().handler(request);

export { handle as GET, handle as POST };
