import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

import { installDesktopMock } from "./desktop-mock";

installDesktopMock();

beforeEach(() => {
  installDesktopMock();
});
