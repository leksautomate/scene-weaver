import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { GenerationProvider } from "@/lib/GenerationContext";
import { AuthProvider } from "@/lib/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import Index from "./pages/Index";
import Projects from "./pages/Projects";
import ProjectStatus from "./pages/ProjectStatus";
import ProjectPreview from "./pages/ProjectPreview";
import Settings from "./pages/Settings";
import ErrorLog from "./pages/ErrorLog";
import JsonToVideo from "./pages/JsonToVideo";
import ImageModelTest from "./pages/ImageModelTest";
import ScriptToJson from "./pages/ScriptToJson";
import TextToVideo from "./pages/TextToVideo";
import TextToVideoDetail from "./pages/TextToVideoDetail";
import OverlayTest from "./pages/OverlayTest";
import Setup from "./pages/Setup";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <GenerationProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              <Route path="/setup" element={<Setup />} />
              <Route path="/login" element={<Login />} />
              <Route path="/overlay-test" element={<OverlayTest />} />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <AppLayout>
                      <Routes>
                        <Route path="/" element={<Index />} />
                        <Route path="/projects" element={<Projects />} />
                        <Route path="/projects/:projectId" element={<ProjectStatus />} />
                        <Route path="/projects/:projectId/preview" element={<ProjectPreview />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/errors" element={<ErrorLog />} />
                        <Route path="/json-to-video" element={<JsonToVideo />} />
                        <Route path="/image-test" element={<ImageModelTest />} />
                        <Route path="/script-to-json" element={<ScriptToJson />} />
                        <Route path="/text-to-video" element={<TextToVideo />} />
                        <Route path="/text-to-video/:jobId" element={<TextToVideoDetail />} />
                        <Route path="*" element={<NotFound />} />
                      </Routes>
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </GenerationProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
