/** The plan identify() reported ("pro", "free"...). Paid plans stand out; free stays quiet. */
export function PlanBadge({ plan }: { plan: string | null | undefined }) {
  if (!plan) return null;
  const free = plan === 'free';
  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-xs capitalize ${
        free
          ? 'border-stone-200 text-stone-500'
          : 'border-violet-300 bg-violet-50 font-medium text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300'
      }`}
    >
      {plan}
    </span>
  );
}
