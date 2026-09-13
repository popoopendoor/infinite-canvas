import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { Alert, Button, Spin } from "antd";
import { RefreshCw } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { fetchSession } from "@/services/api/auth";
import { fetchPublishedModels } from "@/services/api/model-catalog";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function AuthGate({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const status = useUserStore((state) => state.status);
    const error = useUserStore((state) => state.error);
    const setAuthenticated = useUserStore((state) => state.setAuthenticated);
    const setAnonymous = useUserStore((state) => state.setAnonymous);
    const setUnavailable = useUserStore((state) => state.setUnavailable);
    const applyPublishedModels = useConfigStore((state) => state.applyPublishedModels);
    const requestedPath = `${location.pathname}${location.search}${location.hash}`;
    const requestRef = useRef(0);

    const load = () => {
        const requestId = ++requestRef.current;
        void fetchSession()
            .then(async (result) => {
                if (requestId !== requestRef.current) return;
                if (result.authenticated) {
                    const models = await fetchPublishedModels();
                    if (requestId !== requestRef.current) return;
                    if (models !== null) applyPublishedModels(models);
                    setAuthenticated(result.user);
                } else setAnonymous();
            })
            .catch((reason: unknown) => {
                if (requestId !== requestRef.current) return;
                setUnavailable(reason instanceof Error ? reason.message : t("auth.serviceUnavailable"));
            });
    };

    useEffect(() => {
        if (status === "unknown") load();
    }, [status]);

    useEffect(() => {
        const refreshOnReturn = () => {
            if (status === "authenticated" && document.visibilityState === "visible") load();
        };
        window.addEventListener("focus", refreshOnReturn);
        document.addEventListener("visibilitychange", refreshOnReturn);
        return () => {
            window.removeEventListener("focus", refreshOnReturn);
            document.removeEventListener("visibilitychange", refreshOnReturn);
        };
    }, [status]);

    useEffect(() => {
        if (status === "anonymous") navigate(`/login?returnTo=${encodeURIComponent(requestedPath)}`, { replace: true });
    }, [navigate, requestedPath, status]);

    if (status === "authenticated") return <>{children}</>;
    if (status === "unavailable") {
        return (
            <main className="flex h-dvh items-center justify-center bg-background px-6 text-foreground">
                <section className="w-full max-w-md space-y-5">
                    <Alert type="error" showIcon message={t("auth.serviceUnavailable")} description={error || t("auth.retryDescription")} />
                    <Button type="primary" icon={<RefreshCw className="size-4" />} onClick={load}>
                        {t("auth.retry")}
                    </Button>
                </section>
            </main>
        );
    }
    if (status === "anonymous") return null;
    return (
        <main className="flex h-dvh items-center justify-center bg-background text-foreground">
            <Spin size="large" aria-label={t("auth.checking")} />
        </main>
    );
}
