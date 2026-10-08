import FloatingAssistant from "@/components/assistant/floating-assistant";
import "./globals.css";
import "./workspace-design.css";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui";
export const metadata = {
  title: {
    default: "DataVault — Your company, connected.",
    template: "%s · DataVault",
  },
  description:
    "A secure home for your company’s data. Organize files, control access, and bring your team together.",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <ToastProvider>
            {children}
            <FloatingAssistant />
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
