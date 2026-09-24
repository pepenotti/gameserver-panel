import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ApiError } from './api/http';
import { SessionProvider } from './api/session';
import { App } from './App';
import './i18n';
import { theme } from './theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Auth and permission errors won't fix themselves by retrying.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <QueryClientProvider client={queryClient}>
        <ModalsProvider>
          <Notifications position="top-right" />
          <BrowserRouter>
            <SessionProvider>
              <App />
            </SessionProvider>
          </BrowserRouter>
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
