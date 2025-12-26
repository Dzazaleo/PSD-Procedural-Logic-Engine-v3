import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { Psd } from 'ag-psd';
import { TemplateMetadata, MappingContext, TransformedPayload, LayoutStrategy } from '../types';

interface ProceduralState {
  // Maps NodeID -> Raw PSD Object (Binary/Structure)
  psdRegistry: Record<string, Psd>;
  
  // Maps NodeID -> Lightweight Template Metadata
  templateRegistry: Record<string, TemplateMetadata>;
  
  // Maps NodeID -> HandleID -> Resolved Context (Layers + Bounds)
  resolvedRegistry: Record<string, Record<string, MappingContext>>;

  // Maps NodeID -> HandleID -> Transformed Payload (Ready for Assembly)
  payloadRegistry: Record<string, Record<string, TransformedPayload>>;

  // Maps NodeID -> HandleID -> LayoutStrategy (AI Analysis)
  analysisRegistry: Record<string, Record<string, LayoutStrategy>>;

  // Global counter to force re-evaluation of downstream nodes upon binary re-hydration
  globalVersion: number;

  // Credit Management
  userCredits: number;
  isPro: boolean;
}

interface ProceduralContextType extends ProceduralState {
  registerPsd: (nodeId: string, psd: Psd) => void;
  registerTemplate: (nodeId: string, template: TemplateMetadata) => void;
  registerResolved: (nodeId: string, handleId: string, context: MappingContext) => void;
  registerPayload: (nodeId: string, handleId: string, payload: TransformedPayload) => void;
  registerAnalysis: (nodeId: string, handleId: string, strategy: LayoutStrategy) => void;
  updatePreview: (nodeId: string, handleId: string, url: string) => void; // New method for AI Ghosts
  unregisterNode: (nodeId: string) => void;
  triggerGlobalRefresh: () => void;
  
  // Credit Actions
  consumeCredit: (amount: number) => boolean;
  addCredits: (amount: number) => void;
  setCredits: (amount: number) => void; // New method for restoration
  setProStatus: (status: boolean) => void;
}

const ProceduralContext = createContext<ProceduralContextType | null>(null);

export const ProceduralStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [psdRegistry, setPsdRegistry] = useState<Record<string, Psd>>({});
  const [templateRegistry, setTemplateRegistry] = useState<Record<string, TemplateMetadata>>({});
  const [resolvedRegistry, setResolvedRegistry] = useState<Record<string, Record<string, MappingContext>>>({});
  const [payloadRegistry, setPayloadRegistry] = useState<Record<string, Record<string, TransformedPayload>>>({});
  const [analysisRegistry, setAnalysisRegistry] = useState<Record<string, Record<string, LayoutStrategy>>>({});
  const [globalVersion, setGlobalVersion] = useState<number>(0);

  // Credit State
  const [userCredits, setUserCredits] = useState<number>(5);
  const [isPro, setIsPro] = useState<boolean>(false);

  const registerPsd = useCallback((nodeId: string, psd: Psd) => {
    setPsdRegistry(prev => ({ ...prev, [nodeId]: psd }));
  }, []);

  const registerTemplate = useCallback((nodeId: string, template: TemplateMetadata) => {
    setTemplateRegistry(prev => {
      if (prev[nodeId] === template) return prev;
      if (JSON.stringify(prev[nodeId]) === JSON.stringify(template)) return prev;
      return { ...prev, [nodeId]: template };
    });
  }, []);

  const registerResolved = useCallback((nodeId: string, handleId: string, context: MappingContext) => {
    // SANITATION LOGIC (Ghost Flushing)
    // If the Analyst explicitly switches to GEOMETRIC, we must strip any generative artifacts (previewUrl, prompt)
    // before they are committed to the source of truth. This prevents downstream nodes (Remapper, Export) 
    // from seeing stale ghosts or attempting to generate invalid content.
    let sanitizedContext = context;

    if (context.aiStrategy?.method === 'GEOMETRIC') {
        sanitizedContext = {
            ...context,
            // Flush Ghost Preview
            previewUrl: undefined,
            // Flush Generative Intent
            aiStrategy: {
                ...context.aiStrategy,
                generativePrompt: ''
            }
        };
    }

    setResolvedRegistry(prev => {
      const nodeRecord = prev[nodeId] || {};
      const currentContext = nodeRecord[handleId];
      if (currentContext === sanitizedContext) return prev;
      if (currentContext && JSON.stringify(currentContext) === JSON.stringify(sanitizedContext)) return prev;
      
      return {
        ...prev,
        [nodeId]: {
          ...nodeRecord,
          [handleId]: sanitizedContext
        }
      };
    });
  }, []);

  const registerPayload = useCallback((nodeId: string, handleId: string, payload: TransformedPayload) => {
    setPayloadRegistry(prev => {
      const nodeRecord = prev[nodeId] || {};
      const currentPayload = nodeRecord[handleId];

      if (currentPayload === payload) return prev;

      // CHECK FOR NON-BILLABLE DRAFT REFRESH
      // If the payload exists and the only significant change is the previewUrl,
      // we identify this as a visual refinement ("Ghost") update.
      if (currentPayload) {
          const isPreviewChanged = currentPayload.previewUrl !== payload.previewUrl;
          
          // Logic: Structural properties (status, requirements) should remain stable during a draft refresh.
          const isStructureStable = 
              currentPayload.status === payload.status &&
              currentPayload.requiresGeneration === payload.requiresGeneration;

          if (isPreviewChanged && isStructureStable) {
               // EMIT EVENT: Notify listeners (RemapperNode UI) of a non-billable visual update.
               // This allows the UI to trigger animations or feedback without re-mounting entirely.
               const event = new CustomEvent('payload-updated', { 
                   detail: { 
                       nodeId, 
                       handleId, 
                       type: 'DRAFT_REFRESH',
                       isBillable: false,
                       newPreviewUrl: payload.previewUrl
                   } 
               });
               // Dispatch on next tick to avoid synchronous side-effects inside state setter
               setTimeout(() => window.dispatchEvent(event), 0);
          }
      }

      if (currentPayload && JSON.stringify(currentPayload) === JSON.stringify(payload)) return prev;

      return { 
        ...prev, 
        [nodeId]: {
            ...nodeRecord,
            [handleId]: payload
        } 
      };
    });
  }, []);

  const registerAnalysis = useCallback((nodeId: string, handleId: string, strategy: LayoutStrategy) => {
    setAnalysisRegistry(prev => {
        const nodeRecord = prev[nodeId] || {};
        const currentStrategy = nodeRecord[handleId];
        
        if (currentStrategy === strategy) return prev;
        if (currentStrategy && JSON.stringify(currentStrategy) === JSON.stringify(strategy)) return prev;
        
        return { 
            ...prev, 
            [nodeId]: {
                ...nodeRecord,
                [handleId]: strategy
            } 
        };
    });
  }, []);

  // NEW: Granular update for previews to avoid full re-registration loops
  const updatePreview = useCallback((nodeId: string, handleId: string, url: string) => {
    setPayloadRegistry(prev => {
      const nodeRecord = prev[nodeId];
      if (!nodeRecord) return prev; // Cannot update preview if payload doesn't exist
      
      const currentPayload = nodeRecord[handleId];
      if (!currentPayload) return prev;

      // Avoid unnecessary updates if URL matches
      if (currentPayload.previewUrl === url) return prev;

      return {
        ...prev,
        [nodeId]: {
          ...nodeRecord,
          [handleId]: {
            ...currentPayload,
            previewUrl: url
          }
        }
      };
    });
  }, []);

  const unregisterNode = useCallback((nodeId: string) => {
    setPsdRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setTemplateRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setResolvedRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setPayloadRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
    setAnalysisRegistry(prev => { const { [nodeId]: _, ...rest } = prev; return rest; });
  }, []);

  const triggerGlobalRefresh = useCallback(() => {
    setGlobalVersion(v => v + 1);
  }, []);

  // Credit Logic
  const consumeCredit = useCallback((amount: number): boolean => {
    if (userCredits >= amount) {
        setUserCredits(prev => prev - amount);
        return true;
    }
    return false;
  }, [userCredits]);

  const addCredits = useCallback((amount: number) => {
    setUserCredits(prev => prev + amount);
  }, []);

  const setCredits = useCallback((amount: number) => {
    setUserCredits(amount);
  }, []);

  const setProStatus = useCallback((status: boolean) => {
    setIsPro(status);
  }, []);

  const value = useMemo(() => ({
    psdRegistry,
    templateRegistry,
    resolvedRegistry,
    payloadRegistry,
    analysisRegistry,
    globalVersion,
    userCredits,
    isPro,
    registerPsd,
    registerTemplate,
    registerResolved,
    registerPayload,
    registerAnalysis,
    updatePreview,
    unregisterNode,
    triggerGlobalRefresh,
    consumeCredit,
    addCredits,
    setCredits,
    setProStatus
  }), [
    psdRegistry, templateRegistry, resolvedRegistry, payloadRegistry, analysisRegistry, globalVersion,
    userCredits, isPro,
    registerPsd, registerTemplate, registerResolved, registerPayload, registerAnalysis, updatePreview,
    unregisterNode, triggerGlobalRefresh, consumeCredit, addCredits, setCredits, setProStatus
  ]);

  return (
    <ProceduralContext.Provider value={value}>
      {children}
    </ProceduralContext.Provider>
  );
};

export const useProceduralStore = () => {
  const context = useContext(ProceduralContext);
  if (!context) {
    throw new Error('useProceduralStore must be used within a ProceduralStoreProvider');
  }
  return context;
};