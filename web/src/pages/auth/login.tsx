import { Button } from "antd";
import { LogIn } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { startLogin } from "@/services/api/auth";

export default function LoginPage() {
    const { t } = useTranslation();
    const [params] = useSearchParams();
    const returnTo = params.get("returnTo") || "/";

    return (
        <main className="flex h-dvh items-center justify-center bg-background px-6 text-foreground">
            <section className="w-full max-w-md space-y-7 text-center">
                <div>
                    <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-xl bg-stone-950 text-white dark:bg-stone-100 dark:text-stone-950">
                        <LogIn className="size-6" />
                    </div>
                    <h1 className="text-3xl font-semibold tracking-normal">{t("auth.loginTitle")}</h1>
                    <p className="mt-3 text-sm leading-6 text-stone-500 dark:text-stone-400">{t("auth.loginDescription")}</p>
                </div>
                <Button type="primary" size="large" icon={<LogIn className="size-4" />} onClick={() => startLogin(returnTo)}>
                    {t("auth.continueWithFlarum")}
                </Button>
            </section>
        </main>
    );
}
