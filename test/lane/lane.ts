// Each test's own A. Storage is shared within a test file, so a test gets an instance name no
// other test uses, given to the Worker through the binding that names the instance it routes.
import { env } from 'cloudflare:workers';
import worker from '../../src/index';

let current: Env = env;

/** The env of the test now running, which the fetch spy in setup.ts routes the Worker's own origin with. */
export function currentEnv(): Env {
  return current;
}

/** Calls the Worker's real handler with this lane's env, as a request from outside would. */
export function callWorker(request: Request, laneEnv: Env = current): Promise<Response> {
  // A request made here carries no `cf`, which only Cloudflare's edge sets on an incoming one.
  return worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, laneEnv);
}

export interface Lane {
  /** A's instance name in this test, as `A-1f2e3d4c`. */
  name: string;
  /** A's own URI, as `https://….workers.dev/server/A-1f2e3d4c`. */
  root: string;
  env: Env;
  stub: DurableObjectStub<import('../../src/index').Server>;
  /** Requests `path` under A's root, as `/notes/inbox/note-42`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export function newLane(): Lane {
  const name = `A-${crypto.randomUUID().slice(0, 8)}`;
  const laneEnv: Env = { ...env, SERVER_INSTANCE: name };
  current = laneEnv;
  const root = `${env.ORIGIN}/server/${name}`;
  return {
    name,
    root,
    env: laneEnv,
    stub: env.SERVER.getByName(name),
    fetch: (path, init) => callWorker(new Request(`${root}${path}`, init), laneEnv),
  };
}
