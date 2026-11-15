/**
 * The parse of a log: a function, or a validator of the Standard Schema, for example a schema of zod 4, Valibot or ArkType.
 * The types copy the part of the Standard Schema specification, version 1, that the log uses. Thus the package has no
 * dependency on a validator.
 *
 * @packageDocumentation
 */

/** One problem that a validator of the Standard Schema found. The path gives the place of the problem in the value. */
export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

/** The result of a validator of the Standard Schema: the output value, or the problems. */
export type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly StandardIssue[] };

/** The part of a validator of the Standard Schema, version 1, that a log uses. */
export interface StandardSchema<Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: unknown; readonly output: Output } | undefined;
  };
}

/**
 * The parse of the events of a log. It changes a stored JSON value into an event. A function throws on a value that is not
 * an event. A validator of the Standard Schema gives its problems, and the log throws a `SchemaError` with them.
 */
export type Parse<E> = ((value: unknown) => E) | StandardSchema<E>;

/** The error of a value that a validator of the Standard Schema refuses. `issues` has each problem that the validator found. */
export class SchemaError extends TypeError {
  override readonly name = "SchemaError";
  readonly vendor: string;
  readonly issues: readonly StandardIssue[];

  constructor(vendor: string, issues: readonly StandardIssue[]) {
    super(`The schema of ${vendor} refuses the value: ${issues.map(describeIssue).join(". ")}.`);
    this.vendor = vendor;
    this.issues = issues;
  }
}

/** This function gives the text of one problem, for example `items.0.name: Required`. */
function describeIssue(issue: StandardIssue): string {
  const keys = (issue.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment));
  return `${keys.length === 0 ? "The value" : keys.join(".")}: ${issue.message}`;
}

/** This function tells if a parse is a validator of the Standard Schema. A validator of ArkType is also a function. */
function isStandardSchema<E>(parse: Parse<E>): parse is StandardSchema<E> {
  return "~standard" in parse;
}

/** This function tells if a value is a promise or a different thenable. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * This function gives the parse function of a parse. A validator of the Standard Schema must give its result at once,
 * because a log reads its events synchronously.
 */
export function parseFunction<E>(parse: Parse<E>): (value: unknown) => E {
  if (!isStandardSchema(parse)) return parse;
  const standard = parse["~standard"];
  return (value) => {
    const result = standard.validate(value);
    if (isThenable(result)) {
      // The log does not wait for the promise. This handler stops a later rejection from becoming an unhandled rejection.
      result.then(undefined, () => undefined);
      throw new TypeError(`The schema of ${standard.vendor} validates asynchronously. A log reads its events synchronously, so it needs a synchronous schema.`);
    }
    if (result.issues !== undefined) throw new SchemaError(standard.vendor, result.issues);
    return result.value;
  };
}
