import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter, Route, Routes} from "react-router";
import {NotFound} from "@/pages/not-found";
import {RouteProvider} from "@/providers/router-provider";
import {ThemeProvider} from "@/providers/theme-provider";
import EmailGenerator from "@/pages/email-generator";
import "@/styles/globals.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <ThemeProvider>
            <BrowserRouter>
                <RouteProvider>
                    <Routes>
                        <Route path="/" element={<EmailGenerator/>}/>
                        <Route path="*" element={<NotFound/>}/>
                    </Routes>
                </RouteProvider>
            </BrowserRouter>
        </ThemeProvider>
    </StrictMode>,
);
