// The app-wide Api singleton: composes the pure fetch wrapper with the UI store
// so a 401 anywhere drops the user back to the login screen. Features import this;
// api.ts stays free of UI state so it can be unit-tested in isolation.
import { useUi } from "../state/ui";
import { makeApi } from "./api";

export const api = makeApi({ onUnauthorized: () => useUi.setState({ view: "login" }) });
