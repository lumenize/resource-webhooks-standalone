// The Worker the conformance suite runs against, and only locally: the demo's Worker with the
// suite's fixtures added to A. The demo's `main` never imports this module, and it serves
// nothing unless the run sets CONFORMANCE, which no config file does.
import { handleRequest } from '../edge';
import { Server as DemoServer } from '../server';
import { FIXTURES } from './fixtures';

type ConformanceEnv = Env & { CONFORMANCE?: string };

export class Server extends DemoServer {
  static extras = FIXTURES;
}

export default {
  fetch(request: Request, env: ConformanceEnv): Promise<Response> | Response {
    // Deployed by mistake, it still serves nothing: no deployed host is localhost.
    if (env.CONFORMANCE !== 'on' || new URL(request.url).hostname !== 'localhost') {
      // 403, as the suite's DNS-rebinding check expects of a request naming another host.
      return new Response('This Worker serves only a local conformance run', { status: 403 });
    }
    return handleRequest(request, env);
  },
};
