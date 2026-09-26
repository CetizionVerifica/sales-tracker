export function Forbidden() {
  return (
    <section className="flex flex-col gap-2 py-16">
      <h1 className="text-2xl font-semibold">Forbidden</h1>
      <p className="text-muted-foreground">You do not have permission to view this page.</p>
    </section>
  );
}
