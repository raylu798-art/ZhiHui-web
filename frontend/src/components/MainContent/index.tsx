'use client';

import React from 'react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  const { isCollapsed, sidebarWidth, isResizingSidebar } = useSidebar();

  return (
    <main 
      className={`flex-1 ${isResizingSidebar ? '' : 'transition-all duration-300'}`}
      style={{ marginLeft: isCollapsed ? 64 : sidebarWidth }}
    >
      <div className="pl-8">
        {children}
      </div>
    </main>
  );
};

export default MainContent;
