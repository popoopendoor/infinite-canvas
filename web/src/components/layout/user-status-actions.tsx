import type { CSSProperties } from "react";
import { App, Button, Dropdown, Tooltip } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, CircleUserRound, Keyboard, LogIn, LogOut, Puzzle, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { DOCS_URL } from "@/constant/env";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { logout, startLogin } from "@/services/api/auth";
import { fetchWalletBalance } from "@/services/api/model-task";
import { useUserStore } from "@/stores/use-user-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass =
        "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const versionStyle = iconStyle;
    const gitHubClassName = "size-7 text-base";
    const gitHubStyle = iconStyle;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });
    const user = useUserStore((state) => state.user);
    const authStatus = useUserStore((state) => state.status);
    const clearSession = useUserStore((state) => state.clearSession);
    const queryClient = useQueryClient();
    const { message } = App.useApp();
    const [loggingOut, setLoggingOut] = useState(false);
    const [wallet, setWallet] = useState<{ status: "idle" | "loading" | "ready" | "unavailable"; balance?: number }>({ status: "idle" });

    useEffect(() => {
        setWallet({ status: "idle" });
    }, [user?.id]);

    const loadWallet = async () => {
        if (wallet.status === "loading") return;
        setWallet({ status: "loading" });
        try {
            setWallet({ status: "ready", balance: await fetchWalletBalance() });
        } catch {
            setWallet({ status: "unavailable" });
        }
    };

    const handleLogout = async () => {
        setLoggingOut(true);
        try {
            await logout();
            queryClient.clear();
            clearSession();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("auth.logoutFailed"));
        } finally {
            setLoggingOut(false);
        }
    };

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label={t("topNav.plugins")} title={t("topNav.plugins")}>
                    <Puzzle className="size-4" />
                </button>
            ) : null}
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={naturalIconClass} style={iconStyle} aria-label={t("topNav.docs")} title={t("topNav.docs")}>
                <BookOpen className="size-4" />
            </a>
            {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("navigation.config")} title={t("navigation.config")}>
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
                <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                    {locale === "zh-CN" ? "中" : "EN"}
                </button>
            </Tooltip>
            <AnimatedThemeToggler
                theme={theme}
                onThemeChange={setTheme}
                className={naturalIconClass}
                style={iconStyle}
                aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")}
                title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")}
            />
            <VersionReleaseModal style={versionStyle} />
            <GitHubLink className={cn("bg-transparent hover:bg-transparent dark:hover:bg-transparent", gitHubClassName)} style={gitHubStyle} />
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            {authStatus === "authenticated" && user ? (
                <Dropdown
                    trigger={["click"]}
                    onOpenChange={(open) => {
                        if (open) void loadWallet();
                    }}
                    menu={{
                        items: [
                            { key: "identity", label: <span className="max-w-44 truncate">{user.displayName || user.username}</span>, disabled: true },
                            { type: "divider" },
                            {
                                key: "balance",
                                label: wallet.status === "ready" ? t("auth.balance", { balance: wallet.balance }) : wallet.status === "unavailable" ? t("auth.balanceUnavailable") : t("auth.balanceLoading"),
                                disabled: true,
                            },
                            { key: "logout", label: t("auth.logout"), icon: <LogOut className="size-4" />, danger: true, disabled: loggingOut, onClick: () => void handleLogout() },
                        ],
                    }}
                >
                    <Button type="text" shape="circle" loading={loggingOut} className="!h-8 !w-8 !min-w-8" icon={<CircleUserRound className="size-4" />} aria-label={t("auth.accountMenu")} title={user.displayName || user.username} />
                </Dropdown>
            ) : authStatus === "anonymous" ? (
                <Tooltip title={t("auth.login")}>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => startLogin(window.location.pathname + window.location.search + window.location.hash)} aria-label={t("auth.login")} title={t("auth.login")}>
                        <LogIn className="size-4" />
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}
