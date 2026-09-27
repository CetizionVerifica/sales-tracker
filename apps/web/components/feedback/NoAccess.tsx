/**
 * A page the user's role cannot use (UI guide §6): never a blank screen. Records owned by
 * someone else still show the not-found page instead, so their existence doesn't leak
 * (M4 Decision 7).
 */
export function NoAccess() {
  return (
    <section className="flex flex-col gap-2 py-16">
      <h1 className="text-[22px] leading-7 font-semibold">No access</h1>
      <p className="text-muted-foreground">
        You don’t have access to this page. Ask an admin if you need it.
      </p>
    </section>
  );
}
