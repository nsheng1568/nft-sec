// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.4;

import "./loans/direct/loanTypes/DirectLoanBaseMinimal.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract NftSec is ERC1155Supply, IERC1155Receiver {

    struct Underlying {
        uint256 loanPrincipal;
        uint256 loanProceeds;
        uint64 loanEndTime;
        uint256 auctionEndTime;
        uint32 loanId;
        bool liquidated;
    }

    struct Product {
        address owner;
        uint256 tokenOffset;
        uint256[] trancheInterestRates;
        uint256[] trancheNotionals;
        Underlying[] underlyings;
        uint256[] tranchePayouts;
        bool payoutsComputed;
        uint256 startTime;
        uint256 endTime;
        uint256 residualPrice;
    }

    struct UnderlyingLookup {
        uint32 productId;
        uint32 underlyingIndex;
    }

    uint64 private constant DAY_IN_SECONDS = 86400;
    // address private constant WETH = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    // address private constant NFTFI = address(0x8252Df1d8b29057d1Afe3062bf5a64D503152BC8);
    // address private constant ERC721_WRAPPER = address(0xB2C2fCe38a0B7A89aB51F046B7052892Ba55EB2B);
    // uint256 private constant MIN_AUCTION_TIME = 5 * DAY_IN_SECONDS;
    // uint256 private constant BOUNTY_TIME = 1 * DAY_IN_SECONDS;
    address private WETH;
    address private NFTFI;
    address private ERC721_WRAPPER;
    uint256 private MIN_AUCTION_TIME;
    uint256 private BOUNTY_TIME;

    mapping(uint32 => Product) private productIdToProduct;
    mapping(address => mapping(uint256 => UnderlyingLookup)) private nftIdToLookup;
    uint32 private currentProductId = 0;
    uint256 private currentTokenOffset = 0;

    constructor(
        address weth,
        address nftfi,
        address erc721Wrapper,
        uint256 minAuctionTime,
        uint256 bountyTime
    ) ERC1155("") {
        WETH = weth;
        NFTFI = nftfi;
        ERC721_WRAPPER = erc721Wrapper;
        MIN_AUCTION_TIME = minAuctionTime;
        BOUNTY_TIME = bountyTime;
    }

    function mint(
        uint256[] calldata trancheInterestRates,
        uint256[] calldata trancheNotionals,
        uint32[] calldata loanIds,
        uint256 productDuration,
        uint256 residualPrice
    ) external {
        require(trancheInterestRates.length < 32, "Too many tranches");
        require(trancheInterestRates.length == trancheNotionals.length, "Number of interest rates and notionals don't match");

        Product storage product = productIdToProduct[currentProductId];
        for (uint32 i = 0; i < loanIds.length; i++) {
            Underlying memory underlying;
            underlying.loanId = loanIds[i];
            uint256 loanRepayment;
            uint256 nftId;
            uint32 loanDuration;
            uint16 loanAdminFee;
            uint64 loanStartTime;
            address nftContract;
            {
                (
                    underlying.loanPrincipal,
                    loanRepayment,
                    nftId,
                    ,
                    loanDuration,
                    ,
                    loanAdminFee,
                    ,
                    loanStartTime,
                    nftContract,
                ) = DirectLoanBaseMinimal(NFTFI).loanIdToLoan(underlying.loanId);
            }

            underlying.loanProceeds = (loanRepayment - underlying.loanPrincipal) * (10000 - loanAdminFee) / 10000 + underlying.loanPrincipal;
            underlying.loanEndTime = loanStartTime + loanDuration;
            underlying.auctionEndTime = block.timestamp + productDuration;
            require(underlying.loanEndTime + MIN_AUCTION_TIME + BOUNTY_TIME < underlying.auctionEndTime, "Product duration too short for underlyings");
            nftIdToLookup[nftContract][nftId] = UnderlyingLookup(currentProductId, i);
            product.underlyings.push(underlying);
        }
        product.owner = msg.sender;
        product.tokenOffset = currentTokenOffset;
        product.startTime = block.timestamp;
        product.endTime = product.startTime + productDuration;
        product.residualPrice = residualPrice;
        for (uint8 trancheId = 0; trancheId < trancheInterestRates.length; trancheId++) {
            product.trancheInterestRates.push(trancheInterestRates[trancheId]);
            product.trancheNotionals.push(trancheNotionals[trancheId]);
        }
        currentProductId += 1;

        for (uint8 trancheId = 0; trancheId < trancheNotionals.length; trancheId++) {
            _mint(address(this), trancheId + currentTokenOffset, trancheNotionals[trancheId], "");
        }
        _mint(address(this), currentTokenOffset + trancheNotionals.length, 1, "");
        currentTokenOffset += trancheNotionals.length + 1;
    }

    function buyResidual(uint32 productId) external {
        Product memory product = productIdToProduct[productId];
        require(_getTokenQuantity(product, uint8(product.trancheInterestRates.length)) == 1, "Residual already purchased");
        IERC20(WETH).transferFrom(msg.sender, product.owner, product.residualPrice);
        safeTransferFrom(address(this), msg.sender, product.trancheInterestRates.length + product.tokenOffset, 1, "");
    }

    function buyTokens(uint32 productId, uint8 trancheId, uint256 amount) external {
        Product memory product = productIdToProduct[productId];
        require(trancheId < product.trancheInterestRates.length, "Invalid tranche ID");
        require(amount <= _getTokenQuantity(product, trancheId), "Not enough supply remaining");
        uint256 price = _getTokenPrice(product);
        IERC20(WETH).transferFrom(msg.sender, product.owner, price * amount / 10000);
        safeTransferFrom(address(this), msg.sender, trancheId + product.tokenOffset, amount, "");
    }

    function redeemTokens(uint32 productId) external {
        Product storage product = productIdToProduct[productId];
        require(
            block.timestamp > product.endTime
                || (block.timestamp > product.endTime - BOUNTY_TIME && balanceOf(msg.sender, product.trancheInterestRates.length) == 1),
            "Token not yet ready for redemption"
        );
        IERC20 weth = IERC20(WETH);

        if (!product.payoutsComputed) {
            DirectLoanBaseMinimal nftfi = DirectLoanBaseMinimal(NFTFI);
            uint256 totalProceeds = 0;
            for (uint32 i = 0; i < product.underlyings.length; i++) {
                if (product.underlyings[i].liquidated || nftfi.loanRepaidOrLiquidated(product.underlyings[i].loanId)) {
                    totalProceeds += product.underlyings[i].loanProceeds;
                }
            }
            totalProceeds -= 10**17; // computation bounty
            for (uint8 trancheId = 0; trancheId < product.trancheNotionals.length; trancheId++) {
                uint256 expectedPayout = product.trancheNotionals[trancheId] * (10000 + product.trancheInterestRates[trancheId]) / 10000;
                if (totalProceeds >= expectedPayout) {
                    product.tranchePayouts[trancheId] = expectedPayout;
                    totalProceeds -= expectedPayout;
                } else {
                    product.tranchePayouts[trancheId] = totalProceeds;
                    totalProceeds = 0;
                }
            }
            if (totalProceeds > 0) {
                product.tranchePayouts.push(Math.min(weth.balanceOf(address(this)), totalProceeds)); // remaining goes to residual
            }
            product.payoutsComputed = true;
            weth.transfer(msg.sender, 10**17); // pay computation bounty
        }

        for (
            uint256 trancheId = 0;
            trancheId < product.trancheInterestRates.length + 1;
            trancheId++
        ) {
            uint256 tokenId = trancheId + product.tokenOffset;
            uint256 balance = balanceOf(msg.sender, tokenId);
            if (balance > 0) {
                _burn(msg.sender, tokenId, balance);
                weth.transfer(msg.sender, product.tranchePayouts[trancheId] * balance / product.trancheNotionals[trancheId]);
            }
        }
    }

    function liquidateNft(address nftContract, uint256 nftId) external {
        Underlying memory underlying = _getUnderlying(nftContract, nftId);
        uint256 nftPrice = _getNftPrice(underlying.loanPrincipal, underlying.loanEndTime, underlying.auctionEndTime);
        IERC20 weth = IERC20(WETH);
        require(weth.allowance(address(this), msg.sender) >= nftPrice, "Didn't approve enough wETH to liquidate");

        DirectLoanBaseMinimal(NFTFI).liquidateOverdueLoan(underlying.loanId);
        weth.transferFrom(msg.sender, address(this), nftPrice);
        IERC721(nftContract).transferFrom(address(this), msg.sender, nftId);
        underlying.loanProceeds = nftPrice;
    }

    function getResidualPrice(uint32 productId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        require(_getTokenQuantity(product, uint8(product.trancheInterestRates.length)) == 1, "Residual already purchased");
        return product.residualPrice;
    }

    function getTokenPrice(uint32 productId, uint8 trancheId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        require(trancheId < product.trancheInterestRates.length, "Invalid tranche ID");
        require(_getTokenQuantity(product, trancheId) > 0, "No supply remaining");
        return _getTokenPrice(product);
    }

    function getTokenQuantity(uint32 productId, uint8 trancheId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        return _getTokenQuantity(product, trancheId);
    }

    function getNftPrice(address nftContract, uint256 nftId) external view returns (uint256) {
        Underlying memory underlying = _getUnderlying(nftContract, nftId);
        require(block.timestamp > underlying.loanEndTime, "Loan not expired yet");
        require(!DirectLoanBaseMinimal(NFTFI).loanRepaidOrLiquidated(underlying.loanId), "Loan already repaid or liquidated");
        return _getNftPrice(underlying.loanPrincipal, underlying.loanEndTime, underlying.auctionEndTime);
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external virtual override returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external virtual override returns (bytes4) {
        revert("ERC1155 batch not supported");
    }

    function _getUnderlying(address nftContract, uint256 nftId) internal view returns (Underlying memory) {
        UnderlyingLookup memory lookup = nftIdToLookup[nftContract][nftId];
        return productIdToProduct[lookup.productId].underlyings[lookup.underlyingIndex];
    }

    function _getTokenQuantity(Product memory product, uint8 trancheId) internal view returns (uint256) {
        return balanceOf(address(this), trancheId + product.tokenOffset);
    }

    function _getTokenPrice(Product memory product) internal view returns (uint256) {
        // Begin sale at price 1.1 wei, and decay linearly until 0 wei at tranche payout time
        return Math.max(0, 11 * 10**3 * (product.endTime - block.timestamp) / (product.endTime - product.startTime));
    }

    function _getNftPrice(uint256 loanPrincipal, uint64 loanEndTime, uint256 auctionEndTime) internal view returns (uint256) {
        // Begin sale at price equal to 1.5x original loan principal, and decay linearly until 0 ETH at tranche payout time
        return Math.max(0, 3 * loanPrincipal * (auctionEndTime - block.timestamp) / (auctionEndTime - loanEndTime) / 2);
    }
}