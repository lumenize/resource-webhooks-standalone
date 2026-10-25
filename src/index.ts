import { handleRequest } from './edge';

export { Gateway } from './gateway';
export { Server } from './server';

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
