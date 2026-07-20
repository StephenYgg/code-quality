import {
  cancelResponseBody,
  readBoundedResponseBody,
} from "./bounded-response.js";
import {
  assertTrustedEndpoint,
  type HttpProviderConfig,
  type ProviderDiagnostic,
  type ProviderReviewRequest,
  type ProviderReviewResponse,
  ProviderError,
  redactSecrets,
  type ReviewProvider,
  validateModelAllowlist,
} from "./provider.js";
import {
  type PreparedProviderSchema,
  prepareProviderResponseSchema,
} from "./response-validator.js";

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
  }
  return remaining;
}

function withRepairInstruction(
  request: ProviderReviewRequest,
  error: ProviderError,
): ProviderReviewRequest {
  return {
    ...request,
    systemInstructions: [
      request.systemInstructions,
      "",
      `The previous response failed validation: ${error.message}`,
      "Return only valid JSON matching the supplied schema.",
    ].join("\n"),
  };
}

interface BoundedFetchResult {
  readonly response: Response;
  readonly bodyText: string;
}

function assertRedirectIsSafe(
  response: Response,
  requestUrl: string,
  endpointOrigin: string,
): void {
  if (response.status < 300 || response.status >= 400) return;
  const location = response.headers.get("location");
  if (location !== null) {
    const redirected = new URL(location, requestUrl);
    if (redirected.origin !== endpointOrigin) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider redirected to a different origin",
      );
    }
  }
  throw new ProviderError(
    "PROVIDER_NETWORK",
    "Provider returned a redirect that is not followed",
  );
}

async function fetchBoundedResponse(options: {
  readonly fetchImpl: typeof fetch;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  readonly endpointOrigin: string;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<BoundedFetchResult> {
  const controller = new AbortController();
  let abortReason: "caller" | "timeout" | undefined;
  const onAbort = () => {
    abortReason = "caller";
    controller.abort();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  const timeout = setTimeout(() => {
    abortReason = abortReason ?? "timeout";
    controller.abort();
  }, options.timeoutMs);
  timeout.unref();
  try {
    if (abortReason === "caller") {
      throw new ProviderError(
        "PROVIDER_ABORTED",
        "Provider call was cancelled",
      );
    }
    const response = await options.fetchImpl(options.url, {
      method: "POST",
      headers: options.headers,
      body: options.bodyText,
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      cancelResponseBody(response, "redirect rejected");
    }
    assertRedirectIsSafe(response, options.url, options.endpointOrigin);
    const bodyText = await readBoundedResponseBody(
      response,
      options.maxResponseBytes,
      controller.signal,
    );
    if (!response.ok) {
      throw new ProviderError(
        "PROVIDER_FAILED",
        "Provider HTTP request failed",
      );
    }
    return { response, bodyText };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (abortReason === "caller") {
      throw new ProviderError(
        "PROVIDER_ABORTED",
        "Provider call was cancelled",
      );
    }
    if (abortReason === "timeout") {
      throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
    }
    throw new ProviderError("PROVIDER_NETWORK", "Provider HTTP request failed");
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", onAbort);
  }
}

export abstract class HttpReviewProvider implements ReviewProvider {
  protected constructor(protected readonly config: HttpProviderConfig) {}

  abstract capabilities(): ReturnType<ReviewProvider["capabilities"]>;
  protected abstract buildRequest(
    request: ProviderReviewRequest,
    credential: string,
  ): {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  };
  protected abstract parseResponse(
    response: Response,
    bodyText: string,
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse>;

  private credentialSnapshot(): string | undefined {
    const env = this.config.env ?? process.env;
    const credential = env[this.config.credentialEnv]?.trim();
    return credential === undefined || credential.length === 0
      ? undefined
      : credential;
  }

  private configurationDiagnostics(
    credential: string | undefined,
  ): readonly ProviderDiagnostic[] {
    const diagnostics = [
      ...assertTrustedEndpoint(
        this.config.endpoint,
        this.config.allowLoopbackHttp === true,
      ),
      ...validateModelAllowlist(this.config.model, this.config.allowedModels),
    ];
    if (this.config.credentialEnv.length === 0 || credential === undefined) {
      diagnostics.push({
        code: "PROVIDER_CREDENTIAL_MISSING",
        message: "Provider credential environment variable is not set",
        path: "/credentialEnv",
      });
    }
    return diagnostics;
  }

  validateConfiguration(): Promise<readonly ProviderDiagnostic[]> {
    return Promise.resolve(
      this.configurationDiagnostics(this.credentialSnapshot()),
    );
  }

  async review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    const deadline = Date.now() + request.timeoutMs;
    if (request.attemptBudget.used >= request.attemptBudget.maxAttempts) {
      throw new ProviderError(
        "PROVIDER_FAILED",
        "Provider attempt budget is exhausted",
      );
    }
    const credential = this.credentialSnapshot();
    const diagnostics = this.configurationDiagnostics(credential);
    if (diagnostics.length > 0) {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        diagnostics[0]?.message ?? "Provider configuration is invalid",
      );
    }
    if (credential === undefined) {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        "Provider credential environment variable is not set",
      );
    }
    const preparedSchema = prepareProviderResponseSchema(
      request.outputSchema,
      request.maxRequestBytes,
    );
    try {
      return await this.runAttempt(
        1,
        request,
        credential,
        deadline,
        preparedSchema,
      );
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER_RESPONSE_INVALID" &&
        request.attemptBudget.maxAttempts === 2 &&
        request.attemptBudget.used < 1
      ) {
        return await this.runAttempt(
          2,
          withRepairInstruction(request, error),
          credential,
          deadline,
          preparedSchema,
        );
      }
      throw error;
    }
  }

  private async runAttempt(
    attemptIndex: 1 | 2,
    request: ProviderReviewRequest,
    credential: string,
    deadline: number,
    preparedSchema: PreparedProviderSchema,
  ): Promise<ProviderReviewResponse> {
    if (request.signal.aborted) {
      throw new ProviderError(
        "PROVIDER_ABORTED",
        "Provider call was cancelled",
      );
    }
    const preparedRequest = {
      ...request,
      outputSchema: preparedSchema.schema,
    } satisfies ProviderReviewRequest;
    const built = this.buildRequest(preparedRequest, credential);
    const bodyText = JSON.stringify(built.body);
    if (Buffer.byteLength(bodyText, "utf8") > request.maxRequestBytes) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_TOO_LARGE",
        "Provider request exceeded its hard limit",
      );
    }
    const result = await fetchBoundedResponse({
      fetchImpl: this.config.fetchImpl ?? fetch,
      url: built.url,
      headers: built.headers,
      bodyText,
      endpointOrigin: new URL(this.config.endpoint).origin,
      maxResponseBytes: request.maxResponseBytes,
      timeoutMs: remainingTimeout(deadline),
      signal: request.signal,
    });
    const parsed = await this.parseResponse(
      result.response,
      result.bodyText,
      request,
    );
    preparedSchema.validator.assertValid(parsed.content);
    return { ...parsed, attemptsUsed: attemptIndex };
  }

  redactDiagnostic(value: unknown): string {
    const environment = this.config.env ?? process.env;
    const credential = environment[this.config.credentialEnv];
    const secrets: string[] = [];
    if (credential !== undefined) {
      const secret = credential.trim();
      if (secret.length > 0) secrets.push(secret);
    }
    return redactSecrets(value, secrets);
  }
}
