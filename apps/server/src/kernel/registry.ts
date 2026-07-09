import { Hono } from "hono";
import type { MicroService, ServiceContext } from "./ports";

export function createKernel(ctx: ServiceContext) {
  const services: MicroService[] = [];
  const started: MicroService[] = [];
  return {
    register(svc: MicroService) {
      services.push(svc);
    },
    async start(app: Hono) {
      for (const svc of services) {
        await svc.init(ctx); // a throwing init aborts startup — deliberate
        started.push(svc);
        if (svc.routes) {
          const sub = new Hono();
          svc.routes(sub, ctx);
          app.route(`/api/${svc.name}`, sub);
        }
        ctx.log.info("service started", { service: svc.name });
      }
    },
    async stop() {
      for (const svc of [...started].reverse()) {
        try {
          await svc.shutdown?.();
        } catch (e) {
          ctx.log.error("shutdown failed", { service: svc.name, err: String(e) });
        }
      }
    },
  };
}
