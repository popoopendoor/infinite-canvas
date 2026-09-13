import { create } from "zustand";

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
};

export type AuthStatus = "unknown" | "authenticated" | "anonymous" | "unavailable";

type UserStore = {
    status: AuthStatus;
    user: LocalUser | null;
    error: string;
    setAuthenticated: (user: LocalUser) => void;
    setAnonymous: () => void;
    setUnavailable: (error: string) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    status: "unknown",
    user: null,
    error: "",
    setAuthenticated: (user) => set({ status: "authenticated", user, error: "" }),
    setAnonymous: () => set({ status: "anonymous", user: null, error: "" }),
    setUnavailable: (error) => set({ status: "unavailable", error }),
    clearSession: () => set({ status: "anonymous", user: null, error: "" }),
}));
