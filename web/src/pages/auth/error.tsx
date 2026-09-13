import { Alert, Button } from "antd";
import { LogIn, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { startLogin } from "@/services/api/auth";

export default function AuthErrorPage() {
    const { t } = useTranslation();
    const [params] = useSearchParams();
    const reason = params.get("reason") || "invalid_callback";
    const message = t(`auth.errors.${reason}`, { defaultValue: t("auth.errors.invalid_callback") });
    return (
        <main className="flex h-dvh items-center justify-center bg-background px-6 text-foreground">
            <section className="w-full max-w-md space-y-5">
                <Alert type="error" showIcon message={t("auth.loginFailed")} description={message} />
                <div className="flex flex-wrap gap-3">
                    <Button type="primary" icon={<RefreshCw className="size-4" />} onClick={() => startLogin("/")}>
                        {t("auth.retryLogin")}
                    </Button>
                    <Button icon={<LogIn className="size-4" />} onClick={() => window.location.assign("/")}>
                        {t("auth.backToApp")}
                    </Button>
                </div>
            </section>
        </main>
    );
}
