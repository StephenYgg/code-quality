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

  validateConfiguration(): Promise<readonly ProviderDiagnostic[]> {
    const diagnostics = [
      ...assertTrustedEndpoint(
        this.config.endpoint,
        this.config.allowLoopbackHttp === true,
      ),
      ...validateModelAllowlist(this.config.model, this.config.allowedModels),
    ];
    if (
      this.config.credentialEnv.length === 0 ||
      process.env[this.config.credentialEnv] === undefined
    ) {
      diagnostics.push({
        code: "PROVIDER_CREDENTIAL_MISSING",
        message: "Provider credential environment variable is not set",
        path: "/credentialEnv",
      });
    }
    return Promise.resolve(diagnostics);
  }

  async review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    const diagnostics = await this.validateConfiguration();
    if (diagnostics.length > 0) {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        diagnostics[0]?.message ?? "Provider configuration is invalid",
      );
    }
    const credential = process.env[this.config.credentialEnv] ?? "";
    const attempt = async (
      attemptIndex: 1 | 2,
    ): Promise<ProviderReviewResponse> => {
      if (request.signal.aborted) {
        throw new ProviderError(
          "PROVIDER_ABORTED",
          "Provider call was cancelled",
        );
      }
      const built = this.buildRequest(request, credential);
      const bodyText = JSON.stringify(built.body);
      if (Buffer.byteLength(bodyText, "utf8") > request.maxRequestBytes) {
        throw new ProviderError(
          "PROVIDER_RESPONSE_TOO_LARGE",
          "Provider request exceeded its hard limit",
        );
      }
      const endpointOrigin = new URL(this.config.endpoint).origin;
      const fetchImpl = this.config.fetchImpl ?? fetch;
      const controller = new AbortController();
      let abortReason: "caller" | "timeout" | undefined;
      const onAbort = () => {
        abortReason = "caller";
        controller.abort();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        abortReason = abortReason ?? "timeout";
        controller.abort();
      }, request.timeoutMs);
      timeout.unref();
      try {
        const response = await fetchImpl(built.url, {
          method: "POST",
          headers: built.headers,
          body: bodyText,
          signal: controller.signal,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location !== null) {
            const redirected = new URL(location, built.url);
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
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > request.maxResponseBytes) {
          throw new ProviderError(
            "PROVIDER_RESPONSE_TOO_LARGE",
            "Provider response exceeded its hard limit",
          );
        }
        if (!response.ok) {
          throw new ProviderError(
            "PROVIDER_FAILED",
            "Provider HTTP request failed",
          );
        }
        const parsed = await this.parseResponse(response, text, request);
        return { ...parsed, attemptsUsed: attemptIndex };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (abortReason === "caller") {
          throw new ProviderError(
            "PROVIDER_ABORTED",
            "Provider call was cancelled",
          );
        }
        if (abortReason === "timeout") {
          throw new ProviderError(
            "PROVIDER_TIMEOUT",
            "Provider call timed out",
          );
        }
        throw new ProviderError(
          "PROVIDER_NETWORK",
          "Provider HTTP request failed",
        );
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", onAbort);
      }
    };

    try {
      return await attempt(1);
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER_RESPONSE_INVALID" &&
        request.attemptBudget.maxAttempts === 2 &&
        request.attemptBudget.used < 1
      ) {
        return attempt(2);
      }
      throw error;
    }
  }

  redactDiagnostic(value: unknown): string {
    const secret = process.env[this.config.credentialEnv];
    return redactSecrets(value, secret === undefined ? [] : [secret]);
  }
}
