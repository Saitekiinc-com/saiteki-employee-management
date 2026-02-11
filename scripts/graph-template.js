
// Graph Data Placeholder (Will be replaced by generation script)
const GRAPH_DATA = __GRAPH_DATA_PLACEHOLDER__;

// --- Constants & Config ---
const colorMap = {
    person: '#818cf8',
    skill: '#60a5fa',
    value: '#34d399',
    interest: '#fb923c',
    motivation: '#f472b6',
};

const edgeColorMap = {
    HAS_SKILL: '#60a5fa40',
    VALUES: '#34d39940',
    INTERESTED_IN: '#fb923c40',
    MOTIVATED_BY: '#f472b640',
    SHARES: '#3b82f660',
    COMPLEMENTS: '#a78bfa80',
    MENTORING_FIT: '#fbbf2480',
    TEAM_SYNERGY: '#34d39980',
};

const aiEdgeTypes = ['SHARES', 'COMPLEMENTS', 'MENTORING_FIT', 'TEAM_SYNERGY'];
const edgeTypeLabels = {
    'SHARES': '共通事項',
    'COMPLEMENTS': '補完関係',
    'MENTORING_FIT': 'メンター相性',
    'TEAM_SYNERGY': 'チーム相乗効果',
    'HAS_SKILL': 'スキル',
    'VALUES': '価値観',
    'INTERESTED_IN': '関心事',
    'MOTIVATED_BY': 'モチベーション'
};
const edgeTypeColors = {
    'SHARES': '#3b82f6',
    'COMPLEMENTS': '#a78bfa',
    'MENTORING_FIT': '#fbbf24',
    'TEAM_SYNERGY': '#34d399',
    'HAS_SKILL': '#60a5fa',
    'VALUES': '#34d399',
    'INTERESTED_IN': '#fb923c',
    'MOTIVATED_BY': '#f472b6'
};

// --- Module 1: StateManager ---
class StateManager {
    constructor() {
        this.state = {
            currentFilter: 'all', // 'all' or specific category
            selectedNodeId: null,
            searchQuery: '',
            // All relation edges hidden by default
            visibleEdgeTypes: new Set()
        };
        this.listeners = [];
    }

    getState() {
        return this.state;
    }

    setState(newState) {
        this.state = { ...this.state, ...newState };
        this.notify();
    }

    subscribe(listener) {
        this.listeners.push(listener);
    }

    notify() {
        this.listeners.forEach(listener => listener(this.state));
    }
}

// --- Module 2: DataProcessor ---
class DataProcessor {
    static process(graphData, state) {
        const { currentFilter, visibleEdgeTypes } = state;
        const allNodes = graphData.nodes;
        const allEdges = graphData.edges;

        // 1. Filter Nodes
        let nodes;
        if (currentFilter === 'all') {
            nodes = [...allNodes];
        } else {
            const personNodes = allNodes.filter(n => n.type === 'person');
            const catNodes = allNodes.filter(n => n.type === 'attribute' && n.categories.includes(currentFilter));
            nodes = [...personNodes, ...catNodes];
        }

        // 2. Filter Edges
        const nodeIds = new Set(nodes.map(n => n.id));
        let edges = allEdges.filter(e => {
            // Both ends must be in filtered nodes
            if (!nodeIds.has(e.source?.id || e.source) || !nodeIds.has(e.target?.id || e.target)) return false;
            // Filter by AI edge types if applicable
            if ((aiEdgeTypes.includes(e.type) && !visibleEdgeTypes.has(e.type))) return false;
            return true;
        });

        // 3. Process Overlapping Edges (Improvement B)
        const pairCount = {};
        edges.forEach(e => {
            const src = e.source?.id || e.source;
            const tgt = e.target?.id || e.target;
            const key = [src, tgt].sort().join('|');
            if (!pairCount[key]) pairCount[key] = { count: 0, edges: [] };
            pairCount[key].count++;
            pairCount[key].edges.push(e);
            e._pairIndex = pairCount[key].count - 1;
            e._pairTotal = 0; // Placeholder
        });

        // Update total for calculating offsets
        Object.values(pairCount).forEach(p => {
            p.edges.forEach(e => e._pairTotal = p.count);
        });

        return { nodes, edges };
    }
}

// --- Module 3: GraphRenderer ---
class GraphRenderer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.width = this.container.clientWidth;
        this.height = this.container.clientHeight;

        this.svg = d3.select('#' + containerId).append('svg')
            .attr('width', this.width)
            .attr('height', this.height);

        this.g = this.svg.append('g'); // Main group for zoom

        this.defs = this.svg.append('defs');
        this.defineMarkers();

        this.simulation = null;
        this.currentZoomScale = 0.8;
        this.onNodeClick = null; // Callback

        this.initZoom();
    }

    defineMarkers() {
        this.defs.append('marker')
            .attr('id', 'arrow-mentoring')
            .attr('viewBox', '0 -5 10 10')
            .attr('refX', 20)
            .attr('refY', 0)
            .attr('markerWidth', 6)
            .attr('markerHeight', 6)
            .attr('orient', 'auto')
            .append('path')
            .attr('d', 'M0,-5L10,0L0,5')
            .attr('fill', edgeTypeColors['MENTORING_FIT']);
    }

    initZoom() {
        this.zoom = d3.zoom()
            .scaleExtent([0.1, 4])
            .on('zoom', (e) => {
                this.g.attr('transform', e.transform);
                this.currentZoomScale = e.transform.k;
                this.updateLabelVisibility();

                // Improvement F & Performance Tweak
                if (this.currentZoomScale < 0.5) {
                    this.g.select('.links').style('opacity', 0.5);
                } else {
                    this.g.select('.links').style('opacity', 1);
                }
            });
        this.svg.call(this.zoom);
    }

    render(data, currentFilter) {
        this.currentFilter = currentFilter;
        this.g.selectAll('*').remove(); // Clear previous render

        // Layers
        this.linkGroup = this.g.append('g').attr('class', 'links');
        this.edgeLabelGroup = this.g.append('g').attr('class', 'edge-labels');
        this.nodeGroup = this.g.append('g').attr('class', 'nodes');
        this.labelGroup = this.g.append('g').attr('class', 'labels');

        // --- Nodes ---
        this.nodes = this.nodeGroup.selectAll('circle')
            .data(data.nodes, d => d.id)
            .enter().append('circle')
            .attr('r', d => this.getNodeRadius(d))
            .attr('fill', d => this.getNodeColor(d))
            .attr('stroke', d => d.type === 'person' ? '#818cf880' : 'none')
            .attr('stroke-width', d => d.type === 'person' ? 2 : 0)
            .attr('cursor', 'pointer')
            .on('click', (event, d) => {
                event.stopPropagation();
                if (this.onNodeClick) this.onNodeClick(d.id);
            })
            .call(this.dragBehavior());

        // --- Edges ---
        this.links = this.linkGroup.selectAll('path')
            .data(data.edges)
            .enter().append('path')
            .attr('stroke', d => this.getEdgeColor(d))
            .attr('stroke-width', d => this.getEdgeStyle(d).width)
            .attr('stroke-opacity', 0.6)
            .attr('fill', 'none')
            .attr('stroke-dasharray', d => this.getEdgeStyle(d).dasharray)
            .attr('marker-end', d => this.getEdgeStyle(d).marker);

        // --- Node Labels ---
        this.labels = this.labelGroup.selectAll('text')
            .data(data.nodes)
            .enter().append('text')
            .text(d => d.label)
            .attr('text-anchor', 'middle')
            .attr('dy', d => d.type === 'person' ? -26 : -14)
            .attr('fill', d => this.getLabelColor(d))
            .attr('font-size', d => this.getLabelSize(d))
            .attr('pointer-events', 'none')
            .attr('stroke', '#0f172a')
            .attr('stroke-width', 3)
            .attr('paint-order', 'stroke');

        // --- Auto Edge Labels (Improvement F: High zoom) ---
        // Pre-create them hidden
        // User requested to remove relation labels. Passing empty array.
        this.autoEdgeLabels = this.edgeLabelGroup.selectAll('.auto-edge-label')
            .data([]) // Empty data to prevent rendering
            .enter().append('text');

        // Setup Tooltip interactions
        this.setupTooltip();

        // Setup Simulation
        this.simulation = d3.forceSimulation(data.nodes)
            .force('link', d3.forceLink(data.edges).id(d => d.id).distance(d => {
                if (d.type === 'SHARES' || aiEdgeTypes.includes(d.type)) return 160;
                return 100;
            }).strength(d => aiEdgeTypes.includes(d.type) ? 0.3 : 0.2))
            .force('charge', d3.forceManyBody().strength(d => d.type === 'person' ? -500 : -120))
            .force('center', d3.forceCenter(this.width / 2, this.height / 2))
            .force('collision', d3.forceCollide().radius(d => d.type === 'person' ? 45 : 20).strength(0.8))
            .force('x', d3.forceX(this.width / 2).strength(0.02))
            .force('y', d3.forceY(this.height / 2).strength(0.02))
            .on('tick', () => {
                this.tick();
            });

        // Initial label update
        this.updateLabelVisibility();

        // Clear background click
        this.svg.on('click', () => {
            if (this.onNodeClick) this.onNodeClick(null);
        });
    }

    tick() {
        // Curved edges (Improvement B)
        this.links.attr('d', d => {
            const dx = d.target.x - d.source.x;
            const dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (d._pairTotal <= 1) {
                const dr = dist * 1.5;
                return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
            }

            const offset = (d._pairIndex - (d._pairTotal - 1) / 2) * 0.8;
            const curvature = 1.2 + offset;
            const dr = dist * curvature;
            const sweep = offset >= 0 ? 1 : 0;

            return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,${sweep} ${d.target.x},${d.target.y}`;
        });

        this.nodes.attr('cx', d => d.x).attr('cy', d => d.y);
        this.labels.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');

        // Labels position
        this.autoEdgeLabels
            .attr('x', d => (d.source.x + d.target.x) / 2)
            .attr('y', d => {
                const midY = (d.source.y + d.target.y) / 2;
                let offsetY = 0;
                if (d._pairTotal > 1) {
                    offsetY = (d._pairIndex - (d._pairTotal - 1) / 2) * 24;
                }
                return midY + offsetY;
            });

        // Sync custom AI edge labels (if enabled in highlight)
        this.edgeLabelGroup.selectAll('.ai-edge-label-group').attr('transform', d => {
            if (!d || !d.source || !d.target) return null;
            const midX = (d.source.x + d.target.x) / 2;
            const midY = (d.source.y + d.target.y) / 2;
            let offsetY = 0;
            if (d._pairTotal > 1) {
                offsetY = (d._pairIndex - (d._pairTotal - 1) / 2) * 24;
            }
            return `translate(${midX}, ${midY + offsetY})`;
        });
    }

    // --- Interaction Methods ---

    highlight(nodeId) {
        if (!nodeId) {
            // Reset to default
            this.nodeGroup.selectAll('circle').transition().duration(300).attr('opacity', 1);
            this.links.transition().duration(300)
                .attr('opacity', 1)
                .attr('stroke-width', d => this.getEdgeStyle(d).width);
            this.labels.transition().duration(300).attr('opacity', d => this.getZoomLabelOpacity(d));

            this.edgeLabelGroup.selectAll('.ai-edge-label-group').remove();
            this.updateLabelVisibility(); // Restore auto labels if valid
            return;
        }

        // Logic for highlighting connected nodes
        const connectedIds = new Set([nodeId]);
        // We need access to current data. this.links.data() gives us the edges.
        const currentEdges = this.links.data();
        currentEdges.forEach(e => {
            const src = e.source.id;
            const tgt = e.target.id;
            if (src === nodeId) connectedIds.add(tgt);
            if (tgt === nodeId) connectedIds.add(src);
        });

        // Dim nodes
        this.nodeGroup.selectAll('circle')
            .transition().duration(200)
            .attr('opacity', n => connectedIds.has(n.id) ? 1 : 0.15);

        // Dim/Highlight Links
        this.links.transition().duration(200)
            .attr('opacity', e => {
                const src = e.source.id;
                const tgt = e.target.id;
                return (src === nodeId || tgt === nodeId) ? 1 : 0.05;
            })
            .attr('stroke-width', e => {
                const src = e.source.id;
                const tgt = e.target.id;
                return (src === nodeId || tgt === nodeId) ? 3 : 0.5;
            });

        // Dim Labels
        this.labels.transition().duration(200)
            .attr('opacity', n => {
                if (n.id === nodeId) return 1;
                return connectedIds.has(n.id) ? 1 : 0.08;
            });

        // Show detailed edge labels for this node
        this.showEdgeDetails(nodeId, currentEdges);
    }

    showEdgeDetails(nodeId, edges) {
        this.edgeLabelGroup.selectAll('.ai-edge-label-group').remove();
        // User requested to remove relation labels.
        // Returning here ensures no text labels are added for edges.
        return;
    }

    focusOnNode(nodeId, graphDataNodes) {
        const node = graphDataNodes.find(n => n.id === nodeId);
        if (!node) return;

        // Auto zoom
        const scale = 1.6;
        const translateX = this.width / 2 - node.x * scale;
        const translateY = this.height / 2 - node.y * scale;

        this.svg.transition().duration(750)
            .call(this.zoom.transform,
                d3.zoomIdentity.translate(translateX, translateY).scale(scale)
            );

        // Pull force (Optional UX enhancement from original)
        // ... (Skipping complex pull force for brevity, zoom is main requirement)
    }

    // --- Helpers ---
    getNodeRadius(node) {
        if (node.type === 'person') return 20;
        const count = node.connectedPeople?.length || 1;
        return Math.min(6 + count * 2, 18);
    }

    getNodeColor(node) {
        if (node.type === 'person') return colorMap.person;

        // Contextual coloring based on filter
        // If the current filter is a category and the node belongs to it, force that color
        if (this.currentFilter && ['skill', 'value', 'interest', 'motivation'].includes(this.currentFilter)) {
            if (node.categories && node.categories.includes(this.currentFilter)) {
                return colorMap[this.currentFilter];
            }
        }

        if (node.color) return node.color;
        const firstCat = node.categories?.[0] || 'skill';
        return colorMap[firstCat] || '#94a3b8';
    }

    getEdgeColor(d) {
        return edgeColorMap[d.type] || '#33415540';
    }

    getEdgeStyle(d) {
        switch (d.type) {
            case 'SHARES': return { dasharray: 'none', width: Math.max(1, d.weight * 0.5), marker: '' };
            case 'COMPLEMENTS': return { dasharray: '8,4', width: 2, marker: '' };
            case 'MENTORING_FIT': return { dasharray: '2,3', width: 2, marker: 'url(#arrow-mentoring)' };
            case 'TEAM_SYNERGY': return { dasharray: 'none', width: 2.5, marker: '' };
            default: return { dasharray: 'none', width: 0.5, marker: '' };
        }
    }

    getLabelColor(d) {
        if (d.type === 'person') return '#e2e8f0';
        const count = d.connectedPeople?.length || 0;
        if (count >= 3) return '#cbd5e1';
        if (count >= 2) return '#94a3b8';
        return '#64748b';
    }

    getLabelSize(d) {
        const scale = 1 / Math.max(this.currentZoomScale, 0.3);
        const base = d.type === 'person' ? 13 : 11;
        return (base * Math.min(scale, 2.5)) + 'px';
    }

    getZoomLabelOpacity(d) {
        if (d.type === 'person') return 1;
        if (this.currentZoomScale >= 0.7) return 1;
        if (this.currentZoomScale >= 0.4) return 0.3;
        return 0;
    }

    updateLabelVisibility() {
        if (!this.labelGroup) return;
        this.labelGroup.selectAll('text')
            .attr('font-size', d => this.getLabelSize(d))
            .attr('opacity', d => this.getZoomLabelOpacity(d));

        // Auto Edge Labels visibility (Improvement E/F)
        if (this.currentZoomScale >= 1.5) {
            this.edgeLabelGroup.selectAll('.auto-edge-label')
                .transition().duration(200)
                .attr('opacity', 0.8);
        } else {
            this.edgeLabelGroup.selectAll('.auto-edge-label')
                .transition().duration(200)
                .attr('opacity', 0);
        }
    }

    dragBehavior() {
        return d3.drag()
            .on('start', (event, d) => {
                if (!event.active) this.simulation.alphaTarget(0.3).restart();
                d.fx = d.x; d.fy = d.y;
            })
            .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
            .on('end', (event, d) => {
                if (!event.active) this.simulation.alphaTarget(0);
                d.fx = null; d.fy = null;
            });
    }

    // New Interaction: Hover Dimming (Improvement C)
    setupTooltip() {
        const tooltip = document.getElementById('tooltip');
        this.nodeGroup.selectAll('circle')
            .on('mousemove', (event) => {
                tooltip.style.left = (event.offsetX + 14) + 'px';
                tooltip.style.top = (event.offsetY - 14) + 'px';
            })
            .on('mouseover', (event, d) => {
                tooltip.style.opacity = 1;
                let sub = '';
                if (d.type === 'person') sub = d.job;
                else sub = (d.connectedPeople?.length || 0) + '名が該当';
                tooltip.innerHTML = `<div class="tt-title">${d.label}</div><div class="tt-sub">${sub}</div>`;

                // Trigger Dimming (Only if no node is selected)
                // But wait, StateManager controls selection. 
                // In a pure Renderer, we might just allow temporary hover dim if no selection.
                // We'll rely on global checked in Highlight or handle locally:
                // Since we don't have direct access to "selectedNodeId" state here unless passed,
                // we will implement a "hoverHighlight" method that can be called responsibly or handle it internally assuming no selection if none active.
                // For simplicity, we implement local hover logic that respects active highlight.
                if (this.g.select('.links path[opacity="0.05"]').empty()) {
                    // No active selection (approximation)
                    this.tempHighlight(d.id);
                }
            })
            .on('mouseout', () => {
                tooltip.style.opacity = 0;
                if (this.g.select('.links path[opacity="0.05"]').empty()) {
                    this.clearTempHighlight();
                }
            });
    }

    tempHighlight(nodeId) {
        const connectedIds = new Set([nodeId]);
        this.links.data().forEach(e => {
            const src = e.source.id;
            const tgt = e.target.id;
            if (src === nodeId) connectedIds.add(tgt);
            if (tgt === nodeId) connectedIds.add(src);
        });

        this.nodeGroup.selectAll('circle').attr('opacity', n => connectedIds.has(n.id) ? 1 : 0.4);
        this.links.attr('opacity', e => {
            const src = e.source.id;
            const tgt = e.target.id;
            return (src === nodeId || tgt === nodeId) ? 0.8 : 0.1;
        });
    }

    clearTempHighlight() {
        this.nodeGroup.selectAll('circle').attr('opacity', 1);
        this.links.attr('opacity', 1);
    }
}

// --- Module 4: UIManager ---
class UIManager {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this.detailPanel = document.getElementById('detail-panel');
        this.stats = document.getElementById('stats');

        // Bind DOM elements
        this.filterSelect = document.getElementById('filter-select');
        this.searchInput = document.getElementById('search-input');

        this.initEvents();
    }

    initEvents() {
        // Filter
        this.filterSelect.addEventListener('change', (e) => {
            this.stateManager.setState({ currentFilter: e.target.value, selectedNodeId: null });
        });

        // Search
        this.searchInput.addEventListener('input', (e) => {
            // Basic search logic could be here, but usually search triggers selection or filter
            // For now just update stateQuery
            this.stateManager.setState({ searchQuery: e.target.value.toLowerCase() });
        });

        // Handle Enter on search to select first match
        this.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const query = e.target.value.toLowerCase();
                const nodes = GRAPH_DATA.nodes;
                const match = nodes.find(n => n.label.toLowerCase().includes(query) || (n.kanji && n.kanji.includes(query)));
                if (match) {
                    this.stateManager.setState({ selectedNodeId: match.id });
                }
            }
        });

        // Edge Toggles
        const toggleMap = {
            'toggle-shares': 'SHARES',
            'toggle-complements': 'COMPLEMENTS',
            'toggle-mentoring': 'MENTORING_FIT',
            'toggle-synergy': 'TEAM_SYNERGY'
        };

        Object.entries(toggleMap).forEach(([id, type]) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => {
                    const currentVisible = this.stateManager.getState().visibleEdgeTypes;
                    const newVisible = new Set(currentVisible);
                    if (e.target.checked) {
                        newVisible.add(type);
                    } else {
                        newVisible.delete(type);
                    }
                    this.stateManager.setState({ visibleEdgeTypes: newVisible });
                });
            }
        });
    }

    updateStats(meta) {
        this.stats.innerHTML = `
          <span><span class="dot" style="background:#818cf8"></span>${meta.employee_count}名</span>
          <span><span class="dot" style="background:#60a5fa"></span>${meta.node_count}ノード</span>
          <span><span class="dot" style="background:#34d399"></span>${meta.edge_count}エッジ</span>
          <span>${meta.ai_enhanced ? 'AI拡張済' : ''}</span>
        `;
    }

    updateSidebar(nodeId) {
        if (!nodeId) {
            this.detailPanel.innerHTML = '<div class="detail-empty">ノードをクリックすると<br>詳細が表示されます</div>';
            return;
        }

        const node = GRAPH_DATA.nodes.find(n => n.id === nodeId);
        if (!node) return;

        if (node.type === 'person') {
            this.renderPersonDetail(node);
        } else {
            this.renderCategoryDetail(node);
        }
    }

    renderPersonDetail(node) {
        const p = node.personality || {};

        // Find visible connections
        const connections = GRAPH_DATA.edges.filter(e => {
            const src = e.source?.id || e.source;
            const tgt = e.target?.id || e.target;
            return (src === node.id || tgt === node.id) && aiEdgeTypes.includes(e.type);
        });

        // Chart
        const traits = [
            { label: '開放性', score: p.O || 0, color: '#60a5fa' },
            { label: '誠実性', score: p.C || 0, color: '#34d399' },
            { label: '外向性', score: p.E || 0, color: '#fb923c' },
            { label: '協調性', score: p.A || 0, color: '#a78bfa' },
            { label: '安定性', score: 10 - (p.N || 0), color: '#f472b6' },
        ];
        const personalityHTML = traits.map(t =>
            `<div class="p-bar"><span class="p-label">${t.label}</span><div class="p-track"><div class="p-fill" style="width:${t.score * 10}%;background:${t.color}"></div></div><span class="p-score">${t.score}</span></div>`
        ).join('');

        // Connections List (Improvement D)
        let connHTML = '';
        if (connections.length > 0) {
            connections.sort((a, b) => b.weight - a.weight);
            connHTML = '<div class="connections-list"><h4>🤝 つながりの強い社員</h4>';
            connections.slice(0, 8).forEach(e => {
                const src = e.source?.id || e.source;
                const tgt = e.target?.id || e.target;
                const otherId = src === node.id ? tgt : src;
                const otherNode = GRAPH_DATA.nodes.find(n => n.id === otherId);
                const otherLabel = otherNode ? otherNode.label : otherId;

                const typeName = edgeTypeLabels[e.type] || e.type;
                const typeColor = edgeTypeColors[e.type] || '#94a3b8';
                const reason = e.reason || '';

                // Clickable card with data-id attribute for global delegation event or inline
                // We'll use a globally accessible function for simplicity in HTML string
                // But essentially we want to call stateManager.setState
                connHTML += `<div class="conn-card" style="cursor:pointer" onclick="window.app.navigateTo('${otherId}')">
                  <div class="conn-card-header">
                    <span class="conn-card-name">${otherLabel}</span>
                    <span class="conn-card-badge" style="background:${typeColor}20;color:${typeColor}">${typeName}</span>
                  </div>
                  ${reason ? '<div class="conn-card-reason">' + reason + '</div>' : ''}
                </div>`;
            });
            connHTML += '</div>';
        }

        // Attribute Tags (Skills, Values, Interests)
        // Need to find edges that link this person to attributes
        const attrEdges = GRAPH_DATA.edges.filter(e => {
            const src = e.source?.id || e.source;
            return src === node.id && !aiEdgeTypes.includes(e.type);
        });
        const attrNodes = attrEdges.map(e => {
            const tgtId = e.target?.id || e.target;
            return GRAPH_DATA.nodes.find(n => n.id === tgtId);
        }).filter(Boolean);

        const skills = attrNodes.filter(n => n.categories?.includes('skill'));
        const values = attrNodes.filter(n => n.categories?.includes('value'));
        const interests = attrNodes.filter(n => n.categories?.includes('interest'));

        let tagsHTML = '';
        if (skills.length > 0) tagsHTML += '<h4 style="margin:12px 0 6px;font-size:12px;color:#94a3b8">🔧 スキル</h4><div class="conn-card-tags">' + skills.map(s => '<span class="tag tag-skill">' + s.label + '</span>').join('') + '</div>';
        if (values.length > 0) tagsHTML += '<h4 style="margin:12px 0 6px;font-size:12px;color:#94a3b8">💎 価値観</h4><div class="conn-card-tags">' + values.map(v => '<span class="tag tag-value">' + v.label + '</span>').join('') + '</div>';
        if (interests.length > 0) tagsHTML += '<h4 style="margin:12px 0 6px;font-size:12px;color:#94a3b8">🎯 関心事</h4><div class="conn-card-tags">' + interests.map(i => '<span class="tag tag-interest">' + i.label + '</span>').join('') + '</div>';


        this.detailPanel.innerHTML = `
          <div class="detail-card">
            <h3>${node.label}</h3>
            <div class="job">${node.job}</div>
            <div class="summary">${node.summary}</div>
            <div class="personality-section">
              <h4 style="font-size:12px;color:#94a3b8;margin-bottom:8px">🧠 性格特性</h4>
              ${personalityHTML}
            </div>
            ${connHTML}
            ${tagsHTML}
          </div>
        `;
    }

    renderCategoryDetail(node) {
        const people = node.connectedPeople || [];
        this.detailPanel.innerHTML = `
          <div class="detail-card">
            <h3>${node.label}</h3>
            <div class="job">${node.categories?.join(', ')}</div>
            <div class="summary">該当社員: ${people.length}名</div>
            <div style="font-size:12px">${people.map(p => '<div style="padding:6px 0;border-bottom:1px solid #1e293b">' + p + '</div>').join('')}</div>
          </div>
        `;
    }
}

// --- Module 5: Main ---
class App {
    constructor() {
        this.stateManager = new StateManager();
        this.renderer = null; // Deferred init until DOM ready if needed, but here we can just init
        this.uiManager = null;
    }

    init() {
        this.uiManager = new UIManager(this.stateManager);
        this.renderer = new GraphRenderer('graph-container');

        // Expose helper for clickable HTML
        window.app = this;

        // Initial Sidebar Stats
        this.uiManager.updateStats(GRAPH_DATA.metadata);

        // Subscribe to state changes
        this.stateManager.subscribe(this.onStateChange.bind(this));

        // Connect Renderer Events
        this.renderer.onNodeClick = (nodeId) => {
            this.stateManager.setState({ selectedNodeId: nodeId });
        };

        // Initial Render
        this.onStateChange(this.stateManager.getState());

        // Handle Resize
        window.addEventListener('resize', () => {
            // Reload page or re-init renderer (simplest is reload for D3 exact dimensions)
            // or just update SVG dims
            if (!this.renderer) return;
            const container = document.getElementById('graph-container');
            this.renderer.width = container.clientWidth;
            this.renderer.height = container.clientHeight;
            this.renderer.svg.attr('width', this.renderer.width).attr('height', this.renderer.height);
            this.renderer.simulation.force('center', d3.forceCenter(this.renderer.width / 2, this.renderer.height / 2));
            this.renderer.simulation.alpha(0.3).restart();
        });
    }

    onStateChange(state) {
        // 1. Process Data
        const renderData = DataProcessor.process(GRAPH_DATA, state);

        // 2. Render Graph
        // Note: We only re-render if data (filter) changes, 
        // but if only selection changes, we just highlight.
        // For simplicity, we can let D3 handle updates, but distinguishing is better for performance.

        // Check if we need full re-render (nodes changed)
        // Simplified: Always pass data to render, let D3 handle enter/exit
        this.renderer.render(renderData, state.currentFilter);

        // 3. Handle Selection/Highlight
        if (state.selectedNodeId) {
            this.renderer.highlight(state.selectedNodeId);
            this.renderer.focusOnNode(state.selectedNodeId, renderData.nodes);
        } else {
            this.renderer.highlight(null);
        }

        // 4. Update Sidebar
        this.uiManager.updateSidebar(state.selectedNodeId);
    }

    // Helper for HTML onClick
    navigateTo(nodeId) {
        this.stateManager.setState({ selectedNodeId: nodeId });
    }
}

// Start App
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
