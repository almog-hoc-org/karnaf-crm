// The counterpart to EmptyState, for when a list is empty because the fetch
// failed rather than because there is no work.
//
// Every work screen used to collapse the two: a 500 from the API produced
// the same "🎉 אין כרגע טיפול פתוח" as a genuinely clear queue. An operator
// reading that closes the tab and goes home, while leads sit unanswered.
// Distinguishing them is the whole point — and offering the retry means the
// operator is not stuck waiting for the next poll.

export function LoadFailed({
  error,
  onRetry,
  retrying = false,
  title = 'לא הצלחנו לטעון את הנתונים',
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  title?: string;
}) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    <div
      className="kf-tone-danger flex flex-col items-center justify-center gap-2 rounded-xl px-4 py-10 text-center ring-1 ring-inset"
      role="alert"
    >
      <span aria-hidden="true" className="text-3xl opacity-80">⚠️</span>
      <p className="font-semibold">{title}</p>
      <p className="text-sm">
        זו תקלת טעינה — <strong>לא</strong> אומר שאין עבודה. ייתכן שיש לידים שממתינים ואינם מוצגים.
      </p>
      {message ? <p className="max-w-lg break-words text-xs opacity-80">{message}</p> : null}
      {onRetry ? (
        <button type="button" className="kf-btn mt-2" onClick={onRetry} disabled={retrying}>
          {retrying ? 'מנסה שוב...' : 'נסה שוב'}
        </button>
      ) : null}
    </div>
  );
}
