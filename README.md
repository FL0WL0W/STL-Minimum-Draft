# STL Minimum Draft

An interactive web-based tool for analyzing and optimizing 3D models for draft angles to be used in molds

## What It Does

This application takes STL 3D models and performs the following operations:

- **Draft Angle Analysis**: Evaluates your model to identify surfaces that comply with minimum draft angle requirements for manufacturing
- **Geometry Optimization**: Processes and clips faces to create a manufacturable geometry based on specified draft angle thresholds
- **Interactive Preview**: Provides a real-time WebGL visualization to preview your model and the results of draft analysis
- **STL Export**: Generates STL files with the minimum draft angle

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## Important Note

⚠️ **This application currently generates STL files that may have geometry inconsistencies.** All exported STL files should be repaired using an online repair service before 3D printing.

**Recommended repair tool**: https://www.formware.co/onlinestlrepair

The repair service will fix any mesh issues and ensure your model is ready for printing.

## Technologies Used

- **Three.js** - 3D graphics and visualization
- **Clipper-lib** - Polygon clipping operations
- **Earcut** - Polygon triangulation
- **Webpack** - Module bundling

## Development

The application is built with a modular structure:
- `drafter.js` - Core draft analysis engine
- `analysis.js` - Geometric analysis utilities
- `clipFaces.js` - Face clipping and processing
- `scene.js` - 3D scene management
- `state.js` - Application state management
