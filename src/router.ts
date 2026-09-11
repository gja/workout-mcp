// A very small router: `:name` segments with optional regex constraints, tried in
// declaration order, 405 kept distinct from 404. See docs/architecture.md.

/** The `:name` segments of a pattern, as a type. `Params<'/a/:b'>` is `{ b: string }`. */
export type Params<Pattern extends string> = Record<ParamNames<Pattern>, string>;

type ParamNames<Pattern extends string> = Pattern extends `${infer Head}/${infer Tail}`
  ? ParamName<Head> | ParamNames<Tail>
  : ParamName<Pattern>;

type ParamName<Segment extends string> = Segment extends `:${infer Name}(${string})`
  ? Name
  : Segment extends `:${infer Name}`
    ? Name
    : never;

export type Handler<Context, Pattern extends string = string> = (
  context: Context & { params: Params<Pattern> },
) => Response | Promise<Response>;

/** All the router needs of a context. */
export type Routable = { path: string };

export type Fallbacks<Context> = {
  /** The path exists, but not with this method. */
  methodNotAllowed: Handler<Context>;
  /** No route claimed the path. */
  notFound: Handler<Context>;
};

type Route<Context> = {
  methods: readonly string[];
  pattern: RegExp;
  handler: Handler<Context>;
};

const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/auth/:provider/start` -> `/^\/auth\/(?<provider>[^/]+)\/start$/`. */
function compile(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map((segment) => {
      const param = /^:([A-Za-z][A-Za-z0-9_]*)(?:\((.+)\))?$/.exec(segment);
      return param ? `(?<${param[1]}>${param[2] ?? '[^/]+'})` : escape(segment);
    })
    .join('/');
  return new RegExp(`^${source}$`);
}

const serves = (route: { methods: readonly string[] }, method: string): boolean =>
  route.methods.includes(method) || (method === 'HEAD' && route.methods.includes('GET'));

export class Router<Context extends Routable> {
  private readonly routes: Route<Context>[] = [];

  constructor(private readonly fallbacks: Fallbacks<Context>) {}

  on<Pattern extends string>(
    methods: readonly string[],
    pattern: Pattern,
    handler: Handler<Context, Pattern>,
  ): this {
    this.routes.push({ methods, pattern: compile(pattern), handler: handler as Handler<Context> });
    return this;
  }

  get<Pattern extends string>(pattern: Pattern, handler: Handler<Context, Pattern>): this {
    return this.on(['GET'], pattern, handler);
  }

  post<Pattern extends string>(pattern: Pattern, handler: Handler<Context, Pattern>): this {
    return this.on(['POST'], pattern, handler);
  }

  put<Pattern extends string>(pattern: Pattern, handler: Handler<Context, Pattern>): this {
    return this.on(['PUT'], pattern, handler);
  }

  delete<Pattern extends string>(pattern: Pattern, handler: Handler<Context, Pattern>): this {
    return this.on(['DELETE'], pattern, handler);
  }

  /** Add a group of routes declared elsewhere, so the table can span files. */
  mount(group: (router: this) => void): this {
    group(this);
    return this;
  }

  handle(method: string, context: Context): Response | Promise<Response> {
    let pathExists = false;

    for (const route of this.routes) {
      const match = route.pattern.exec(context.path);
      if (!match) continue;
      if (!serves(route, method)) {
        pathExists = true;
        continue;
      }
      return route.handler({ ...context, params: match.groups ?? {} });
    }

    const fallback = pathExists ? this.fallbacks.methodNotAllowed : this.fallbacks.notFound;
    return fallback({ ...context, params: {} });
  }
}
