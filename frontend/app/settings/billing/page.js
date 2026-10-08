import { redirect } from "next/navigation";
// Compatibility with the backend's existing example portal return URL.
export default function Page() {
  redirect("/payments/return");
}
