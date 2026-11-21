/** Test stub: decorator bookkeeping only. */
const decorated = [];
export class TypertRemoteService {
  constructor(ctx, name) { this.ctx = ctx; this.serviceName = name; }
}
export function Remote(name) {
  return (target, context) => {
    decorated.push({ name, method: context?.name ?? String(name) });
    return target;
  };
}
export const __decoratedMethods = decorated;
