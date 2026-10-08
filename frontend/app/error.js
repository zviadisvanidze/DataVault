"use client";
export default function Error({ reset }) {
  return (
    <main className="center-screen">
      <h1>Something didn’t load.</h1>
      <p>Try reloading this view to reconnect with your workspace.</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
