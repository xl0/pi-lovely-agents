const ACCOUNT_LIMIT =
	/(?:GoUsageLimitError|FreeUsageLimitError|insufficient[_ -]?quota|\bquota\b|\bbilling\b|\bbudget\b|usage[_ -]?limit|usage[_ -]?not[_ -]?included|available balance)/i
const TRANSIENT_LIMIT = /(?:rate[_ -]?limit|too many requests|\b429\b|ResourceExhausted|RESOURCE_EXHAUSTED)/i
const NON_LIMIT_TRANSIENT =
	/(?:overload(?:ed)?|\b5\d\d\b|service[_ -]?unavailable|server[_ -]?error|internal[_ -]?error|network[_ -]?error|connection[_ -]?(?:error|refused|lost)|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream[_ -]?connect|reset before headers|socket hang up|timed? out|timeout|websocket[_ -]?(?:closed|error))/i

/** True only for terminal provider errors that should suspend an exact model tuple. */
export function isProviderLimitError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false
	if (ACCOUNT_LIMIT.test(errorMessage)) return true
	return TRANSIENT_LIMIT.test(errorMessage) && !NON_LIMIT_TRANSIENT.test(errorMessage)
}
