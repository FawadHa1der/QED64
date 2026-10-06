// A Cloudflare Worker on qed64/edge, the widgets showcase's shape (docs/DEPLOY.md).
import { createWorker, isImmutable } from "qed64/edge";

type Env = { R2_PREFIX?: string; ROOT_REDIRECT?: string };

export default createWorker<Env>({
  r2Prefix: (env) => env.R2_PREFIX,
  rootRedirect: (env) => env.ROOT_REDIRECT ?? null,
});
export { isImmutable };
