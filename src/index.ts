import { handleRequest } from './edge';

export { Server } from './server';

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
