import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import Index from "./pages/Index";
import Projects from "./pages/Projects";
import ProjectStatus from "./pages/ProjectStatus";
import ProjectPreview from "./pages/ProjectPreview";
import Settings from "./pages/Settings";
import ErrorLog from "./pages/ErrorLog";
import TextSplitter from "./pages/TextSplitter";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<ProjectStatus />} />
            <Route path="/projects/:projectId/preview" element={<ProjectPreview />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/errors" element={<ErrorLog />} />
            <Route path="/text-splitter" element={<TextSplitter />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
