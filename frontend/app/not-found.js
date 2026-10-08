import Link from "next/link";
export default function NotFound() {
  return (
    <main className="center-screen">
      <span className="eyebrow">404 / NOT FOUND</span>
      <h1>This page isn’t in your vault.</h1>
      <Link className="button" href="/dashboard">
        Back to your workspace
      </Link>
    </main>
  );
}
